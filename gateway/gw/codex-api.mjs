import { connectionDraft } from "./codex-connection.mjs";
import { providerRequest, readApiJson, apiEvents, apiError, safeApiMessage } from "./codex-api-http.mjs";
import { refreshModelCatalog, rememberApiModels, customModels } from "./codex-models.mjs";

function candidates(config) {
  const u = new URL(config.baseUrl);
  return u.pathname === "/" ? [config.baseUrl + "/v1", config.baseUrl] : [config.baseUrl];
}
function failure(e, config, url, started) {
  return { ok: false, url, code: e.code || (e.name === "TimeoutError" ? "timeout" : "network"),
    status: e.upstreamStatus || 0, message: safeApiMessage(e, config.apiKey), elapsedMs: Date.now() - started };
}

export async function discoverApiModels(body, { signal, timeoutMs = 10000 } = {}) {
  const config = connectionDraft(body, { requireModel: false, allowAuto: true }), attempts = [];
  // Public capabilities also refresh when the provider is offline or /models is
  // unavailable. This request has no provider credentials.
  await refreshModelCatalog({signal});
  for (const baseUrl of candidates(config)) {
    const started = Date.now(), url = baseUrl + "/models";
    try {
      const data = await readApiJson(await providerRequest({ ...config, baseUrl }, "/models", { signal, timeoutMs }));
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : null;
      if (!rows) throw apiError("invalid_models", "接口没有返回模型列表，可手动填写模型名称");
      const models = [...new Set(rows.map((r) => typeof r === "string" ? r : r?.id).filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)))].sort().slice(0, 2000);
      if (!models.length) throw apiError("empty_models", "接口模型列表为空，可手动填写模型名称");
      const modelDetails = rememberApiModels(baseUrl, models.map(id => rows.find(row => row?.id === id) || id));
      if(baseUrl!==config.baseUrl)rememberApiModels(config.baseUrl,models.map(id=>rows.find(row=>row?.id===id)||id));
      attempts.push({ ok: true, url, status: 200, elapsedMs: Date.now() - started });
      return { ok: true, baseUrl, models, modelDetails, attempts };
    } catch (e) {
      attempts.push(failure(e, config, url, started));
      if (!["html", "not_found", "invalid_json", "invalid_models"].includes(e.code) || signal?.aborted) break;
    }
  }
  return { ok: false, models: [], modelDetails:customModels(config.baseUrl,config.model),metadataSource:"models.dev/cache",message: attempts.at(-1).message, attempts };
}

async function verifyStream(response, wireApi) {
  if (/application\/json/i.test(response.headers.get("content-type") || "")) {
    const data = await readApiJson(response);
    if (data.error) throw apiError("provider", "模型请求被拒绝，请检查模型名称和访问权限");
    if (wireApi === "responses" && data.object === "response" && data.status === "completed" && data.output?.some((i) => i.type === "message" && i.content?.some((p) => p.type === "output_text" && p.text?.trim()))) return;
    if (wireApi === "chat" && data.choices?.[0]?.message?.content?.trim() && data.choices[0].finish_reason === "stop") return;
    throw apiError("invalid_response", "接口回包与所选协议不匹配");
  }
  let text = "";
  for await (const event of apiEvents(response, 1 << 20)) {
    if (event.error || ["response.failed", "response.incomplete", "error"].includes(event.type)) throw apiError("provider", "模型测试未完成，请检查模型权限、额度和服务端状态");
    if (wireApi === "responses" && event.type === "response.output_text.delta") text += event.delta || "";
    if (wireApi === "responses" && event.type === "response.completed" && event.response?.status === "completed") {
      if (text.trim() || event.response.output?.some((i) => i.type === "message" && i.content?.some((p) => p.type === "output_text" && p.text?.trim()))) return;
      throw apiError("empty_response", "接口没有返回回复正文，不能确认任务可用");
    }
    if (wireApi === "chat" && event.choices?.[0]) {
      const choice = event.choices[0];
      if (typeof choice.delta?.content === "string") text += choice.delta.content;
      if (choice.finish_reason) {
        if (choice.finish_reason === "stop" && text.trim()) return;
        throw apiError("empty_response", "接口没有完整返回回复正文，请检查模型与服务端状态");
      }
    }
  }
  throw apiError("incomplete_stream", "接口流式响应未完整结束，请检查协议与服务端状态");
}

export async function testApiConnection(body, { signal, timeoutMs = 20000 } = {}) {
  const config = connectionDraft(body, { allowAuto: true }), attempts = [];
  // DeepSeek exposes Chat Completions natively. Some gateways accept a short
  // Responses request yet fail on Codex's tool/context payload. Explicit choices
  // still win; do not retry a real task through another protocol.
  const preferChat = /(?:^|\/)deepseek(?:[-_/]|$)/i.test(config.model);
  const protocols = config.wireApi === "auto" ? (preferChat ? ["chat", "responses"] : ["responses", "chat"]) : [config.wireApi];
  for (const baseUrl of candidates(config)) {
    for (const wireApi of protocols) {
      const started = Date.now(), suffix = wireApi === "chat" ? "/chat/completions" : "/responses";
      const request = wireApi === "chat"
        ? { model: config.model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 256, stream: true }
        : { model: config.model, instructions: "API compatibility check. Reply OK without calling tools.",
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK." }] }],
          tools: [{ type: "custom", name: "compatibility_check", description: "Unused compatibility check tool.", format: { type: "text" } }],
          tool_choice: "none", max_output_tokens: 256, stream: true, store: false };
      try {
        await verifyStream(await providerRequest({ ...config, baseUrl }, suffix, { body: request, signal, timeoutMs }), wireApi);
        const elapsedMs = Date.now() - started;
        attempts.push({ ok: true, url: baseUrl + suffix, wireApi, status: 200, elapsedMs });
        return { ok: true, baseUrl, wireApi, model: config.model, elapsedMs, attempts };
      } catch (e) {
        attempts.push({ ...failure(e, config, baseUrl + suffix, started), wireApi });
        // A rejected key, quota, network failure or model error is not a reason to send
        // another billable request using a different protocol.
        if (!["html", "not_found", "invalid_json", "invalid_response", "invalid_stream"].includes(e.code) || signal?.aborted)
          return { ok: false, message: attempts.at(-1).message, attempts };
      }
    }
  }
  return { ok: false, message: attempts.at(-1).message, attempts };
}
