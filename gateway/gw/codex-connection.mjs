import path from "node:path";
import crypto from "node:crypto";
import { CFG, log } from "./config.mjs";
import { loadState, writeAtomic } from "./statefile.mjs";
import { safeApiMessage } from "./codex-api-http.mjs";
import { customModels, modelSettings, saveModelSettingsBatch, validateModelSettings } from "./codex-models.mjs";

const FILE = path.join(CFG.home, "coxdragon-codex-connection.json");
export const CUSTOM_PROVIDER = "coxdragon_custom";
const KEY_ENV = "COXDRAGON_CUSTOM_API_KEY";
const stored = loadState(FILE, { max: 512 << 10, shape: (v) => v && typeof v === "object" && !Array.isArray(v) ? v : undefined }).data;
let profiles=Array.isArray(stored.profiles)?stored.profiles.filter(p=>p&&typeof p.id==="string"&&p.id!=="chatgpt"&&p.id.length<=80&&typeof p.baseUrl==="string"&&typeof p.model==="string").slice(0,20).map(p=>({
  id:p.id,baseUrl:p.baseUrl,model:p.model,name:typeof p.name==="string"?p.name.slice(0,80):"",
  apiKey:typeof p.apiKey==="string"?p.apiKey:"",noKey:p.noKey===true,wireApi:p.wireApi==="chat"?"chat":"responses",
  effort:typeof p.effort==="string"?p.effort:"",contextWindow:Number.isSafeInteger(p.contextWindow)&&p.contextWindow>=1024&&p.contextWindow<=1e9?p.contextWindow:0
  ,modelIds:Array.isArray(p.modelIds)?p.modelIds.filter(id=>typeof id==="string"&&id.length>0&&id.length<=200).slice(0,100):undefined
})):[];
if(!profiles.length&&stored.baseUrl&&stored.model)profiles=[{...stored,id:"custom"}];
let connection = {
  mode: stored.mode === "custom" ? "custom" : "chatgpt",
  baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : "",
  model: typeof stored.model === "string" ? stored.model : "",
  apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
  noKey: stored.noKey === true,
  wireApi: stored.wireApi === "chat" ? "chat" : "responses",
  effort: typeof stored.effort === "string" ? stored.effort : "",
  contextWindow: Number.isSafeInteger(stored.contextWindow) && stored.contextWindow >= 1024 && stored.contextWindow<=1e9 ? stored.contextWindow : 0,
  providerId: typeof stored.providerId === "string" ? stored.providerId : profiles[0]?.id || "custom",
  name: typeof stored.name === "string" ? stored.name.slice(0,80) : "",
  modelIds:Array.isArray(stored.modelIds)?stored.modelIds:undefined,
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
      const nextProfiles=profiles.map(p=>p.id===connection.providerId?{...p,wireApi:"chat"}:p);
      if (writeAtomic(FILE, JSON.stringify({...next,profiles:nextProfiles}), { mode: 0o600 })) {
        connection = next;
        profiles=nextProfiles;
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
  const profile=body.providerId?profiles.find(p=>p.id===body.providerId):null;
  if(body.providerId&&!profile)throw invalid("提供商配置不存在，请刷新后重试");
  const baseUrl = normalizeApiUrl(body.baseUrl ?? profile?.baseUrl);
  const model = typeof body.model === "string" ? body.model.trim() : profile?.model || "";
  if ((requireModel && !model) || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw invalid("请输入有效的模型名称");
  const wireApi = body.wireApi || profile?.wireApi || "responses";
  if (!["responses", "chat", ...(allowAuto ? ["auto"] : [])].includes(wireApi)) throw invalid("请选择 Responses 或 Chat Completions 协议，自动识别需先测试连接");
  const noKey = body.noKey === undefined ? profile?.noKey === true : body.noKey === true;
  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length > 16384 || /[\x00-\x1f\x7f]/.test(apiKey)) throw invalid("API Key 格式无效");
  if (noKey) apiKey = "";
  else if (!apiKey) {
    const previous=profile||(body.newProvider===true?{}:connection);
    if (baseUrl !== previous.baseUrl || !previous.apiKey) throw invalid("请输入 API Key，或选择接口无需密钥");
    apiKey = previous.apiKey;
  }
  const savedSelection=modelSettings(baseUrl,model);
  const effort = typeof body.effort === "string" ? body.effort : savedSelection.effort ?? (baseUrl === connection.baseUrl && model === connection.model ? connection.effort : profile?.model===model?profile.effort||"":"");
  if (effort && !customModels(baseUrl, model).find(m => m.id === model)?.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw invalid("这个模型不支持所选思考强度");
  const contextWindow = body.contextWindow === undefined ? savedSelection.contextWindow ?? (baseUrl === connection.baseUrl && model === connection.model ? connection.contextWindow : profile?.model===model?profile.contextWindow||0:0) : body.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 0 || (contextWindow > 0 && contextWindow < 1024) || contextWindow > 1e9) throw invalid("上下文大小应为 1024 到 1000000000 的整数，留空使用默认值");
  if(body.modelIds!==undefined&&(!Array.isArray(body.modelIds)||!body.modelIds.length||body.modelIds.length>100||body.modelIds.some(id=>typeof id!=="string"||!id||id.length>200||/[\x00-\x1f\x7f]/.test(id))||new Set(body.modelIds).size!==body.modelIds.length||!body.modelIds.includes(model)))throw invalid("模型列表无效，必须包含默认模型且不能重复");
  return { mode: "custom", baseUrl, model, apiKey, noKey, wireApi, effort, contextWindow,
    providerId:profile?.id || (body.newProvider===true?null:baseUrl===connection.baseUrl?connection.providerId:profiles.find(p=>p.baseUrl===baseUrl)?.id) || crypto.randomUUID(),
    name:typeof body.name==="string"?body.name.trim().slice(0,80):profile?.name || (baseUrl===connection.baseUrl?connection.name:""),
    modelIds:Array.isArray(body.modelIds)?body.modelIds:profile?.modelIds||(!body.newProvider&&baseUrl===connection.baseUrl?connection.modelIds:undefined) };
}

export function connectionStatus() {
  let configured = false;
  try { configured = connection.mode === "custom" && normalizeApiUrl(connection.baseUrl) === connection.baseUrl && !!connection.model && (connection.noKey || !!connection.apiKey); } catch {}
  return { mode: connection.mode, baseUrl: connection.baseUrl, model: connection.model,
    hasKey: !!connection.apiKey, noKey: connection.noKey, configured, wireApi: connection.wireApi, effort: connection.effort, contextWindow: connection.contextWindow,providerId:connection.providerId,name:connection.name };
}

export function profileModels(profile) {
  const models=customModels(profile.baseUrl,profile.model);
  return Array.isArray(profile.modelIds)?models.filter(m=>profile.modelIds.includes(m.id)||m.id===profile.model):models;
}
export function connectionModels(){return profileModels(connection);}
export function connectionProfiles(){return profiles.map(p=>{let name=p.name;try{name||=new URL(p.baseUrl).hostname;}catch{name||="Custom API";}return {id:p.id,mode:"custom",name,baseUrl:p.baseUrl,model:p.model,wireApi:p.wireApi,noKey:p.noKey,hasKey:!!p.apiKey,effort:p.effort||"",contextWindow:p.contextWindow||0,modelIds:p.modelIds,models:profileModels(p)};});}

export function connectionErrorMessage(error) {
  return safeApiMessage(error, connection.apiKey).replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
}

export function updateConnection(body) {
  if (!["chatgpt", "custom"].includes(body.mode)) throw invalid("请选择连接方式");
  let modelRows,restoreSettings;
  if(body.mode==="custom"&&body.models!==undefined){
    if(!Array.isArray(body.models)||!body.models.length||body.models.length>100)throw invalid("请添加 1 到 100 个模型");
    const seen=new Set();modelRows=body.models.map(row=>{
      const id=typeof row?.id==="string"?row.id.trim():"";
      if(!id||id.length>200||/[\x00-\x1f\x7f]/.test(id)||seen.has(id))throw invalid("模型 ID 不能为空或重复");seen.add(id);
      return {id,settings:validateModelSettings(row.settings||{})};
    });
    if(!seen.has(body.model))throw invalid("默认模型必须包含在模型列表中");
    const scope=normalizeApiUrl(body.baseUrl??profiles.find(p=>p.id===body.providerId)?.baseUrl);
    restoreSettings=saveModelSettingsBatch(scope,modelRows);
  }
  let next;
  try{next={ ...(body.mode === "custom" ? connectionDraft(body) : { ...connection, mode: body.mode }), compatibilityVersion: 1 };
    if(modelRows)next.modelIds=modelRows.map(r=>r.id);
  }catch(error){restoreSettings?.();throw error;}
  const nextProfiles=next.mode==="custom"?[...profiles.filter(p=>p.id!==next.providerId),{...next,id:next.providerId}]:profiles;
  const activate=body.activate!==false||(connection.mode==="custom"&&connection.providerId===next.providerId),active=activate?next:connection;
  if(nextProfiles.length>20||!writeAtomic(FILE, JSON.stringify({...active,profiles:nextProfiles}), { mode: 0o600 })){
    restoreSettings?.();
    throw new Error(nextProfiles.length>20?"最多保存 20 个提供商":"连接设置没有保存，请检查存储空间后重试");
  }
  connection = active;profiles=nextProfiles;
  return connectionStatus();
}
export function deleteConnectionProfile(id) {
  if(connection.mode==="custom"&&connection.providerId===id)throw invalid("请先切换到其他提供商，再删除当前提供商");
  if(!profiles.some(p=>p.id===id))throw invalid("提供商配置不存在");
  const next=profiles.filter(p=>p.id!==id);
  // ChatGPT mode retains the last custom connection for migration. Deleting
  // that profile must also remove its legacy credential copy.
  const active=connection.providerId===id?{mode:"chatgpt",baseUrl:"",model:"",apiKey:"",noKey:false,wireApi:"responses",effort:"",contextWindow:0,providerId:"custom",name:""}:connection;
  if(!writeAtomic(FILE,JSON.stringify({...active,profiles:next}),{mode:0o600}))throw new Error("提供商没有删除，请重试");
  connection=active;profiles=next;
}

export function updateCustomSelection(model, effort, contextWindow = model === connection.model ? connection.contextWindow : 0) {
  return updateConnection({ ...connection, model, effort, contextWindow,...(connection.modelIds?{modelIds:[...new Set([...connection.modelIds,model])]}:{}) });
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
    // A disconnected stream may already have executed tools. Require an explicit
    // new turn instead of silently replaying calls from an incomplete response.
    [`model_providers.${CUSTOM_PROVIDER}.request_max_retries`]: 1,
    [`model_providers.${CUSTOM_PROVIDER}.stream_max_retries`]: 0,
    [`model_providers.${CUSTOM_PROVIDER}.stream_idle_timeout_ms`]: 90000,
  };
  const model = customModels(connection.baseUrl, connection.model).find(m => m.id === connection.model);
  if (connection.contextWindow || model?.contextWindow) overrides.model_context_window = connection.contextWindow || model.contextWindow;
  if (connection.effort) overrides.model_reasoning_effort = connection.effort;
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
