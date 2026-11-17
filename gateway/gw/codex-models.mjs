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
const SETTINGS = path.join(CFG.home, "coxdragon-model-settings.json");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1e9 ? value : null;
const strings = value => Array.isArray(value) ? [...new Set(value.filter(s => typeof s === "string" && /^[a-z][a-z0-9_-]{0,39}$/i.test(s)))].slice(0, 20) : null;
const modalities = value => strings(value)?.filter(s => ["text", "image", "audio", "video", "pdf"].includes(s)) ?? null;
let catalog;
try { if (fs.statSync(CACHE).size < (2 << 20)) catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE), { maxOutputLength: 16 << 20 })); } catch {}
if (!object(catalog?.providers)) catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)));
const saved = loadState(PROVIDERS, { max: 4 << 20, shape: v => object(v) ? v : undefined }).data;
const configured = loadState(SETTINGS, { max: 1 << 20, shape: v => object(v) ? v : undefined }).data;
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
        const list = index.get(alias) || []; list.push({ model, key, providerId, api: provider.api }); index.set(alias, list);
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

function referenceModel(id) {
  if(typeof id!=="string")return null;
  const split=id.indexOf("/"),providerId=id.slice(0,split),key=id.slice(split+1),provider=catalog.providers[providerId];
  const model=Object.hasOwn(provider?.models||{},key)?provider.models[key]:null;return model?{model,key,providerId}:null;
}
export function searchModelCatalog(query="",limit=40) {
  const words=String(query).toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0,8),rows=[];
  for(const [providerId,provider]of Object.entries(catalog.providers))for(const [key,m]of Object.entries(provider.models||{})){
    const referenceId=providerId+"/"+key,text=(referenceId+" "+m.name).toLowerCase();
    if(words.every(w=>text.includes(w)))rows.push({referenceId,providerId,id:m.id,displayName:m.name||m.id,contextWindow:positive(m.limit?.context),inputModalities:modalities(m.modalities?.input)||[],reasoningOptions:m.reasoning_options||[]});
  }
  const term=String(query).toLowerCase().trim();rows.sort((a,b)=>(a.id.toLowerCase()===term?-1:0)-(b.id.toLowerCase()===term?-1:0)||a.referenceId.localeCompare(b.referenceId));
  return {models:rows.slice(0,Math.min(60,limit)),total:rows.length,updatedAt:catalog.updatedAt};
}

export function modelDetails(row, { baseUrl = "", engine = false, providers = catalog.providers, referenceId = "" } = {}) {
  const id = typeof row === "string" ? row : row.id;
  const api = typeof row === "string" ? {} : row;
  const match = referenceModel(referenceId)||lookup(id, baseUrl, providers), reference = match?.model || {};
  const apiInput = modalities(api.inputModalities ?? api.input_modalities ?? api.modalities?.input ?? api.input ?? api.architecture?.input_modalities);
  const apiOutput = modalities(api.outputModalities ?? api.output_modalities ?? api.modalities?.output ?? api.output ?? api.architecture?.output_modalities);
  const optionValues = value => Array.isArray(value) && value.some(o => o?.type === "effort") ? strings(value.filter(o => o?.type === "effort").flatMap(o => Array.isArray(o.values) ? o.values : [])) : null;
  const rawEfforts = api.supportedReasoningEfforts ?? api.supported_reasoning_efforts ?? api.reasoning_efforts;
  const apiEfforts = Array.isArray(rawEfforts) ? strings(rawEfforts.map(e => typeof e === "string" ? e : e?.reasoningEffort)) : optionValues(api.reasoning_options);
  const efforts = api.reasoning === false ? [] : apiEfforts ?? optionValues(reference.reasoning_options) ?? [];
  const declaredWindow = positive(api.contextWindow ?? api.context_length ?? api.context_window ?? api.max_input_tokens ?? api.top_provider?.context_length ?? api.limit?.context);
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
    referenceId:match?match.providerId+"/"+match.key:null,
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
  for(const key of Object.keys(configured)){
    try{const [scope,id]=JSON.parse(key);if(scope===baseUrl&&typeof id==="string"&&id&&id.length<=200&&!models.some(m=>m.id===id))models.push(modelDetails(id,{baseUrl}));}catch{}
  }
  if (selected&&!models.some(m => m.id === selected)) models.unshift(modelDetails(selected, { baseUrl }));
  return models.map(m => ({ ...configuredModel(baseUrl,m), isDefault: m.id === selected }));
}

const settingKey=(scope,id)=>JSON.stringify([scope,id]);
export function modelSettings(scope,id) {
  const value={...configured[settingKey(scope,id)]};
  // Removing a catalog entry must preserve unrelated user settings.
  if(value.referenceId&&!referenceModel(value.referenceId))delete value.referenceId;
  try{return validateModelSettings(value);}catch{return {};}
}
export function validateModelSettings(value) {
  if(!object(value))throw new Error("模型设置无效");
  const next={};
  if(Object.hasOwn(value,"referenceId")){
    if(value.referenceId!==null&&(typeof value.referenceId!=="string"||value.referenceId.length>400||!referenceModel(value.referenceId)))throw new Error("models.dev 能力模板不存在，请重新选择");
    next.referenceId=value.referenceId;
  }
  if(Object.hasOwn(value,"displayName")){
    if(typeof value.displayName!=="string"||value.displayName.length>200||/[\x00-\x1f\x7f]/.test(value.displayName))throw new Error("模型显示名称无效");
    next.displayName=value.displayName.trim();
  }
  if(Object.hasOwn(value,"contextWindow")){
    if(value.contextWindow!==0&&(!positive(value.contextWindow)||value.contextWindow<1024))throw new Error("上下文大小应为 1024 到 1000000000 的整数，留空使用默认值");
    next.contextWindow=value.contextWindow;
  }
  if(Object.hasOwn(value,"effort")){
    if(typeof value.effort!=="string"||value.effort.length>40||value.effort&&!/^[a-z][a-z0-9_-]*$/i.test(value.effort))throw new Error("思考强度格式无效");
    next.effort=value.effort;
  }
  for(const field of ["inputModalities","supportedReasoningEfforts"]){
    if(!Object.hasOwn(value,field))continue;
    if(value[field]===null){next[field]=null;continue;}
    const result=field==="inputModalities"?modalities(value[field]):strings(value[field]);
    if(!result||result.length!==value[field].length)throw new Error("模型能力设置无效");
    next[field]=result;
  }
  return next;
}
export function saveModelSettings(scope,id,value,{replace=false}={}) {
  const next={...configured,[settingKey(scope,id)]:{...(replace?{}:modelSettings(scope,id)),...validateModelSettings(value)}};
  if(Object.keys(next).length>500||Buffer.byteLength(JSON.stringify(next))>1<<20)throw new Error("模型设置数量过多");
  if(!writeAtomic(SETTINGS,JSON.stringify(next),{mode:0o600}))throw new Error("模型设置没有保存");
  Object.assign(configured,next);return next[settingKey(scope,id)];
}
export function saveModelSettingsBatch(scope,rows,{replace=false}={}) {
  const next={...configured},previous=new Map(rows.map(row=>{const key=settingKey(scope,row.id);return [key,configured[key]];}));
  for(const row of rows)next[settingKey(scope,row.id)]={...(replace?{}:modelSettings(scope,row.id)),...validateModelSettings(row.settings)};
  if(Object.keys(next).length>500||Buffer.byteLength(JSON.stringify(next))>1<<20)throw new Error("模型设置数量过多");
  if(!writeAtomic(SETTINGS,JSON.stringify(next),{mode:0o600}))throw new Error("模型设置没有保存");
  Object.assign(configured,next);
  return ()=>{
    const restored={...configured};
    for(const [key,value]of previous)if(value===undefined)delete restored[key];else restored[key]=value;
    if(!writeAtomic(SETTINGS,JSON.stringify(restored),{mode:0o600}))throw new Error("模型设置未能恢复，请重试保存");
    for(const key of previous.keys())delete configured[key];Object.assign(configured,restored);
  };
}
export function configuredModel(scope,model) {
  const declaredCapabilities=model.declaredCapabilities || {displayName:model.displayName,contextWindow:model.contextWindow,inputModalities:model.inputModalities,
    outputModalities:model.outputModalities,reasoning:model.reasoning,referenceId:model.referenceId,
    supportedReasoningEfforts:model.supportedReasoningEfforts,capabilitySources:model.capabilitySources};
  const settings=modelSettings(scope,model.id),sources={...declaredCapabilities.capabilitySources};
  const result={...model,...declaredCapabilities,declaredCapabilities,settings,capabilitySources:sources};
  if(settings.referenceId){
    const reference=modelDetails(model.id,{referenceId:settings.referenceId});
    for(const [field,source]of [["contextWindow","context"],["inputModalities","input"],["outputModalities","output"],["supportedReasoningEfforts","effort"],["reasoning","reasoning"]]){
      if(!["provider","codex"].includes(sources[source])){result[field]=reference[field];sources[source]=reference.capabilitySources[source];}
    }
    result.referenceId=settings.referenceId;
  }
  if(settings.displayName)result.displayName=settings.displayName;
  if(settings.contextWindow){result.contextWindow=settings.contextWindow;sources.context="user";}
  if(settings.inputModalities!=null){result.inputModalities=settings.inputModalities;sources.input="user";}
  if(settings.supportedReasoningEfforts!=null){result.supportedReasoningEfforts=settings.supportedReasoningEfforts.map(reasoningEffort=>({reasoningEffort,description:reasoningEffort}));sources.effort="user";}
  return result;
}
