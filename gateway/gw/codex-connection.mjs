import path from "node:path";
import { CFG, log } from "./config.mjs";
import { loadState, writeAtomic } from "./statefile.mjs";
import { safeApiMessage } from "./codex-api-http.mjs";

const FILE = path.join(CFG.home, "coxdragon-codex-connection.json");
export const CUSTOM_PROVIDER = "coxdragon_custom";
const KEY_ENV = "COXDRAGON_CUSTOM_API_KEY";
const stored = loadState(FILE, { max: 32768, shape: (v) => v && typeof v === "object" && !Array.isArray(v) ? v : undefined }).data;
let connection = {
  mode: stored.mode === "custom" ? "custom" : "chatgpt",
  baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : "",
  model: typeof stored.model === "string" ? stored.model : "",
  apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
  noKey: stored.noKey === true,
  wireApi: stored.wireApi === "chat" ? "chat" : "responses",
};

// Older automatic probes selected Responses for CodeFlow + DeepSeek even though
// complete Codex requests fail. Migrate that saved default once on upgrade.
// A protocol explicitly saved by this version remains under the user's control.
if (stored.compatibilityVersion !== 1 && connection.mode === "custom" && connection.wireApi === "responses"
    && /(?:^|\/)deepseek(?:[-_/]|$)/i.test(connection.model)) {
  try {
    const url = new URL(connection.baseUrl);
    if (url.protocol === "https:" && url.hostname === "codeflow.sh" && !url.port && !url.username && !url.password && !url.search && !url.hash) {
      const next = { ...connection, wireApi: "chat", compatibilityVersion: 1 };
      if (writeAtomic(FILE, JSON.stringify(next), { mode: 0o600 })) {
        connection = next;
        log("[codex] 已迁移旧 CodeFlow DeepSeek 连接：Responses → Chat Completions（保留密钥与模型）");
      }
    }
  } catch { /* Keep the previous configuration if it cannot be safely saved. */ }
}

function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
export function normalizeApiUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  let u;
  try { u = new URL(raw); } catch { throw invalid("请输入有效的 API 地址"); }
  if (raw.length > 2048 || !["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw invalid("API 地址只支持 HTTP 或 HTTPS，不能包含账号、查询参数或片段");
  u.pathname = u.pathname.replace(/\/(responses|chat\/completions|models)\/?$/, "");
  return u.href.replace(/\/+$/, "");
}

// Draft operations share save validation, without saving a key or restarting the engine.
export function connectionDraft(body, { requireModel = true, allowAuto = false } = {}) {
  const baseUrl = normalizeApiUrl(body.baseUrl);
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if ((requireModel && !model) || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw invalid("请输入有效的模型名称");
  const wireApi = body.wireApi || "responses";
  if (!["responses", "chat", ...(allowAuto ? ["auto"] : [])].includes(wireApi)) throw invalid("请选择 Responses 或 Chat Completions 协议，自动识别需先测试连接");
  const noKey = body.noKey === true;
  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length > 16384 || /[\x00-\x1f\x7f]/.test(apiKey)) throw invalid("API Key 格式无效");
  if (noKey) apiKey = "";
  else if (!apiKey) {
    if (baseUrl !== connection.baseUrl || !connection.apiKey) throw invalid("请输入 API Key，或选择接口无需密钥");
    apiKey = connection.apiKey;
  }
  return { mode: "custom", baseUrl, model, apiKey, noKey, wireApi };
}

export function connectionStatus() {
  let configured = false;
  try { configured = connection.mode === "custom" && normalizeApiUrl(connection.baseUrl) === connection.baseUrl && !!connection.model && (connection.noKey || !!connection.apiKey); } catch {}
  return { mode: connection.mode, baseUrl: connection.baseUrl, model: connection.model,
    hasKey: !!connection.apiKey, noKey: connection.noKey, configured, wireApi: connection.wireApi };
}

export function connectionErrorMessage(error) {
  return safeApiMessage(error, connection.apiKey).replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
}

export function updateConnection(body) {
  if (!["chatgpt", "custom"].includes(body.mode)) throw invalid("请选择连接方式");
  const next = { ...(body.mode === "custom" ? connectionDraft(body) : { ...connection, mode: body.mode }), compatibilityVersion: 1 };
  if (!writeAtomic(FILE, JSON.stringify(next), { mode: 0o600 })) throw new Error("连接设置没有保存，请检查存储空间后重试");
  connection = next;
  return connectionStatus();
}

// CLI 覆盖本客户端的连接，不改写用户的 config.toml。Key 只经子进程环境传入，
// 不进入命令参数、状态 JSON、事件或前端本地存储。
export function connectionLaunch(adapter) {
  const status = connectionStatus();
  if (status.mode !== "custom") return { args: ["-c", 'model_provider="openai"'], env: {}, modelProvider: "openai" };
  if (!status.configured) throw invalid("自定义 API 配置不完整，请重新保存连接设置");
  if (connection.wireApi === "chat" && !adapter) throw invalid("Chat Completions 适配器尚未启动");
  const overrides = {
    model_provider: CUSTOM_PROVIDER, model: connection.model,
    [`model_providers.${CUSTOM_PROVIDER}.name`]: "Custom API",
    [`model_providers.${CUSTOM_PROVIDER}.base_url`]: adapter?.url || connection.baseUrl,
    [`model_providers.${CUSTOM_PROVIDER}.wire_api`]: "responses",
    [`model_providers.${CUSTOM_PROVIDER}.requires_openai_auth`]: false,
    // Bound silent upstream reconnects so an incompatible provider reaches an
    // actionable failure instead of leaving a turn spinning for many minutes.
    [`model_providers.${CUSTOM_PROVIDER}.request_max_retries`]: 1,
    [`model_providers.${CUSTOM_PROVIDER}.stream_max_retries`]: 1,
    [`model_providers.${CUSTOM_PROVIDER}.stream_idle_timeout_ms`]: 90000,
  };
  // Hosted web search is a Responses-only tool. Do not advertise it to a Chat API.
  if (connection.wireApi === "chat") overrides.web_search = "disabled";
  if (adapter || !connection.noKey) overrides[`model_providers.${CUSTOM_PROVIDER}.env_key`] = KEY_ENV;
  return { args: Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    env: adapter ? { [KEY_ENV]: adapter.token } : connection.noKey ? {} : { [KEY_ENV]: connection.apiKey }, modelProvider: CUSTOM_PROVIDER };
}

export async function prepareConnectionLaunch() {
  if (connection.mode !== "custom" || connection.wireApi !== "chat") return connectionLaunch();
  const { startChatAdapter } = await import("./codex-chat-adapter.mjs");
  const adapter = await startChatAdapter({ ...connection });
  return { ...connectionLaunch(adapter), close: adapter.close };
}
