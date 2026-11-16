// Model metadata never receives provider credentials. Exact IDs only; no family guesses.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CFG, LIVE } from "./config.mjs";
import { loadState, writeAtomic } from "./statefile.mjs";
import { readApiJson } from "./codex-api-http.mjs";

const SNAPSHOT = new URL("../data/models-dev.json.gz", import.meta.url);
const CACHE = path.join(CFG.home, "coxdragon-models-dev.json.gz");
const PROVIDERS = path.join(CFG.home, "coxdragon-model-catalog.json");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1e9 ? value : null;
const strings = value => Array.isArray(value) ? [...new Set(value.filter(s => typeof s === "string" && /^[a-z][a-z0-9_-]{0,39}$/i.test(s)))].slice(0, 20) : null;
const modalities = value => strings(value)?.filter(s => ["text", "image", "audio", "video", "pdf"].includes(s)) ?? null;
let catalog;
try { if (fs.statSync(CACHE).size < (2 << 20)) catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE), { maxOutputLength: 16 << 20 })); } catch {}
if (!object(catalog?.providers)) catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)));
const saved = loadState(PROVIDERS, { max: 4 << 20, shape: v => object(v) ? v : undefined }).data;
let refreshing = null, lastAttempt = 0;

export function reduceModelCatalog(data) {
  const providers = {};
  for (const [id, provider] of Object.entries(data || {}).slice(0, 1000)) {
    if (!object(provider?.models)) continue;
    const models = {};
    for (const [key, model] of Object.entries(provider.models).slice(0, 10000)) {
      if (!object(model) || typeof model.id !== "string" || model.id.length > 200) continue;
      models[key] = { id: model.id, name: model.name, canonical_model_id: model.canonical_model_id,
        reasoning: model.reasoning, reasoning_options: model.reasoning_options,
        tool_call: model.tool_call, modalities: model.modalities, limit: model.limit };
    }
    providers[id] = { api: provider.api, models };
  }
  if (!Object.keys(providers).length) throw new Error("Empty model catalog");
  return { updatedAt: Date.now(), providers };
}

// Bundled snapshot is always available. A refresh failure cannot block using a model.
export async function refreshModelCatalog({ signal, fetchImpl = fetch, force = false } = {}) {
  if (!force && (!LIVE || Date.now() - lastAttempt < 3600000 || Date.now() - catalog.updatedAt < 86400000)) return;
  if (refreshing) return refreshing;
  lastAttempt = Date.now();
  refreshing = (async () => {
    try {
      const response = await fetchImpl("https://models.dev/api.json", { redirect: "error", headers: { accept: "application/json" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000) });
      if (!response.ok) return;
      const next = reduceModelCatalog(await readApiJson(response, 12 << 20));
      if (writeAtomic(CACHE, zlib.gzipSync(JSON.stringify(next)))) catalog = next;
    } catch { /* Keep offline metadata. */ }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const indexes = new WeakMap();
function lookup(id, baseUrl, providers) {
  let host = ""; try { host = new URL(baseUrl).hostname; } catch {}
  let index = indexes.get(providers);
  if (!index) {
    index = new Map();
    for (const [providerId, provider] of Object.entries(providers)) for (const [key, model] of Object.entries(provider?.models || {})) {
      if (!object(model) || typeof model.id !== "string") continue;
      for (const alias of new Set([key, model.id, `${providerId}/${model.id}`])) {
        const list = index.get(alias) || []; list.push({ model, providerId, api: provider.api }); index.set(alias, list);
      }
    }
    indexes.set(providers, index);
  }
  const matches = (index.get(id) || []).map(m => { let direct = false; try { direct = !!host && new URL(m.api).hostname === host; } catch {} return { ...m, direct }; });
  const preferred = matches.filter(m => m.direct);
  if (preferred.length === 1) return preferred[0];
  const canonical = matches.filter(m => m.model.canonical_model_id === `${m.providerId}/${m.model.id}` || (!m.model.canonical_model_id && ["openai", "anthropic", "google", "deepseek", "xai", "mistral", "moonshotai", "zai", "minimax", "qwen"].includes(m.providerId)));
  if (canonical.length === 1) return canonical[0];
  return matches.length === 1 ? matches[0] : null;
}

export function modelDetails(row, { baseUrl = "", engine = false, providers = catalog.providers } = {}) {
  const id = typeof row === "string" ? row : row.id;
  const api = typeof row === "string" ? {} : row;
  const match = lookup(id, baseUrl, providers), reference = match?.model || {};
  const apiInput = modalities(api.inputModalities ?? api.modalities?.input);
  const apiOutput = modalities(api.outputModalities ?? api.modalities?.output);
  const optionValues = value => Array.isArray(value) && value.some(o => o?.type === "effort") ? strings(value.filter(o => o?.type === "effort").flatMap(o => Array.isArray(o.values) ? o.values : [])) : null;
  const apiEfforts = Array.isArray(api.supportedReasoningEfforts) ? strings(api.supportedReasoningEfforts.map(e => typeof e === "string" ? e : e?.reasoningEffort)) : optionValues(api.reasoning_options);
  const efforts = api.reasoning === false ? [] : apiEfforts ?? optionValues(reference.reasoning_options) ?? [];
  const declaredWindow = positive(api.contextWindow ?? api.context_length ?? api.context_window ?? api.limit?.context);
  const source = engine ? "codex" : "provider";
  return { id, model: typeof api.model === "string" ? api.model : id, displayName: [api.displayName, api.name, reference.name, id].find(v => typeof v === "string" && v.length > 0)?.slice(0, 200) || id,
    inputModalities: apiInput ?? modalities(reference.modalities?.input) ?? [],
    outputModalities: apiOutput ?? modalities(reference.modalities?.output) ?? [],
    contextWindow: declaredWindow ?? positive(reference.limit?.context),
    reasoning: typeof api.reasoning === "boolean" ? api.reasoning : typeof reference.reasoning === "boolean" ? reference.reasoning : efforts.length ? true : null,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
    capabilitySources: { input: apiInput ? source : reference.modalities?.input ? "models.dev" : null,
      output: apiOutput ? source : reference.modalities?.output ? "models.dev" : null,
      context: declaredWindow ? source : positive(reference.limit?.context) ? "models.dev" : null,
      reasoning: typeof api.reasoning === "boolean" ? source : typeof reference.reasoning === "boolean" ? "models.dev" : null,
      effort: api.reasoning === false || apiEfforts ? source : reference.reasoning_options ? "models.dev" : null },
    metadataUpdatedAt: catalog.updatedAt,
  };
}

export function rememberApiModels(baseUrl, rows) {
  const models = rows.map(row => modelDetails(row, { baseUrl }));
  const next = { ...saved, [baseUrl]: { models, updatedAt: Date.now() } };
  const keys = Object.keys(next).sort((a, b) => next[b].updatedAt - next[a].updatedAt);
  for (const key of keys.slice(12)) delete next[key];
  if (Buffer.byteLength(JSON.stringify(next)) <= (4 << 20) && writeAtomic(PROVIDERS, JSON.stringify(next))) { for (const key of Object.keys(saved)) delete saved[key]; Object.assign(saved, next); }
  return models;
}

export function customModels(baseUrl, selected) {
  const rows = saved[baseUrl]?.models;
  const models = (Array.isArray(rows) ? rows : []).filter(m => m && typeof m.id === "string").map(row => {
    // Keep API declarations; renew only values previously filled from models.dev.
    const api = { id: row.id, displayName: row.displayName };
    for (const [field, source] of [["inputModalities", "input"], ["outputModalities", "output"], ["contextWindow", "context"], ["supportedReasoningEfforts", "effort"]]) {
      if (row.capabilitySources?.[source] === "provider") api[field] = row[field];
    }
    if (row.capabilitySources?.reasoning === "provider") api.reasoning = row.reasoning;
    return modelDetails(api, { baseUrl });
  });
  if (!models.some(m => m.id === selected)) models.unshift(modelDetails(selected, { baseUrl }));
  return models.map(m => ({ ...m, isDefault: m.id === selected }));
}
