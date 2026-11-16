// Codex speaks Responses. This authenticated loopback bridge translates the
// text/image/function/custom-tool subset to third-party Chat Completions.
import http from "node:http";
import crypto from "node:crypto";
import { providerRequest, readApiJson, apiEvents, apiError, safeApiMessage } from "./codex-api-http.mjs";

function content(parts) {
  if (typeof parts === "string") return parts;
  return (parts || []).map((p) => {
    if (["input_text", "output_text", "text"].includes(p.type)) return { type: "text", text: p.text || "" };
    if (p.type === "input_image" && typeof p.image_url === "string") return { type: "image_url", image_url: { url: p.image_url, ...(p.detail ? { detail: p.detail } : {}) } };
    if (p.type === "refusal") return { type: "text", text: p.refusal || "" };
    throw apiError("unsupported", "Chat Completions 暂不支持此内容类型：" + p.type);
  });
}

export function toChatRequest(body) {
  if (body.previous_response_id) throw apiError("unsupported", "Chat Completions 需要完整聊天记录，请使用 Responses 协议恢复此任务");
  const messages = [], custom = new Set(), tools = [], toolMap = new Map();
  const encoded = (name, namespace) => !namespace && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "tool_" + crypto.createHash("sha256").update((namespace || "") + ":" + name).digest("hex").slice(0, 24) + "_" + name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24);
  const addTool = (tool, namespace) => {
    if (tool.type === "namespace") { for (const child of tool.tools || []) addTool(child, tool.name); return; }
    if (!["function", "custom"].includes(tool.type)) throw apiError("unsupported", "Chat Completions 暂不支持此工具类型：" + tool.type + "，请改用 Responses 协议");
    const name = encoded(tool.name, namespace), description = (namespace ? namespace + "." + tool.name + "\n" : "") + (tool.description || "");
    if (toolMap.has(name)) throw apiError("unsupported", "工具名称冲突，请改用 Responses 协议");
    toolMap.set(name, { name: tool.name, namespace });
    if (tool.type === "function") tools.push({ type: "function", function: { name, description, parameters: tool.parameters || { type: "object", properties: {} } } });
    else if (tool.type === "custom") {
      custom.add(name);
      tools.push({ type: "function", function: { name, description: description + "\nPass the exact tool input as the input string.",
        parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } } });
    } else throw apiError("unsupported", "Chat Completions 暂不支持此工具类型：" + tool.type + "，请改用 Responses 协议");
  };
  for (const tool of body.tools || []) addTool(tool);
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input || [];
  for (const item of input) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const call = { id: item.call_id, type: "function", function: { name: encoded(item.name, item.namespace),
        arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments } };
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: content(item.output) });
    } else if (item.type === "message" || (!item.type && item.role)) {
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: content(item.content) });
    } else throw apiError("unsupported", "Chat Completions 暂不支持此记录类型：" + item.type + "，请改用 Responses 协议");
  }
  const request = { model: body.model, messages, stream: true };
  if (tools.length) { request.tools = tools; request.tool_choice = "auto"; }
  if (body.tool_choice) {
    const choice = body.tool_choice;
    request.tool_choice = typeof choice === "string" ? choice : ["function", "custom"].includes(choice.type) ? { type: "function", function: { name: encoded(choice.name, choice.namespace) } } : "auto";
  }
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) if (body[key] != null) request[key] = body[key];
  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) request.reasoning_effort = body.reasoning.effort;
  if (body.text?.format?.type === "json_schema") {
    const { type, ...schema } = body.text.format;
    request.response_format = { type, json_schema: schema };
  }
  return { request, custom, toolMap };
}

async function bridge(body, config, res, signal) {
  const { request, custom, toolMap } = toChatRequest(body);
  const upstream = await providerRequest(config, "/chat/completions", { body: request, signal, timeoutMs: 300000 });
  const streaming = body.stream !== false;
  const id = "resp_" + crypto.randomBytes(12).toString("hex"), created_at = Math.floor(Date.now() / 1000);
  const output = [], calls = new Map();
  let sequence = 0, textItem = null, reasoningItem = null, finish = null, usage = null;
  const response = (status) => ({ id, object: "response", created_at, model: body.model, status, output, usage });
  const emit = (type, data = {}) => {
    if (!streaming || res.destroyed) return;
    if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  };
  emit("response.created", { response: response("in_progress") });
  const addReasoning = (delta) => {
    if (!delta) return;
    if (!reasoningItem) {
      reasoningItem = { id: "rs_" + crypto.randomBytes(10).toString("hex"), type: "reasoning", summary: [{ type: "summary_text", text: "" }] };
      output.push(reasoningItem);
      emit("response.output_item.added", { output_index: output.indexOf(reasoningItem), item: { ...reasoningItem, summary: [] } });
      emit("response.reasoning_summary_part.added", { item_id: reasoningItem.id, output_index: output.indexOf(reasoningItem), summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    reasoningItem.summary[0].text += delta;
    emit("response.reasoning_summary_text.delta", { item_id: reasoningItem.id, output_index: output.indexOf(reasoningItem), summary_index: 0, delta });
  };
  const addText = (delta) => {
    if (!delta) return;
    if (!textItem) {
      textItem = { id: "msg_" + crypto.randomBytes(10).toString("hex"), type: "message", role: "assistant", status: "in_progress", content: [] };
      output.push(textItem);
      emit("response.output_item.added", { output_index: output.indexOf(textItem), item: { ...textItem, content: [] } });
      textItem.content.push({ type: "output_text", text: "", annotations: [] });
      emit("response.content_part.added", { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, part: { ...textItem.content[0] } });
    }
    textItem.content[0].text += delta;
    emit("response.output_text.delta", { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, delta });
  };
  function chunk(data) {
    if (data.error) throw apiError("provider", typeof data.error.message === "string" ? data.error.message : "第三方模型请求失败");
    if (data.usage) usage = { input_tokens: data.usage.prompt_tokens || 0, output_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0, input_tokens_details: { cached_tokens: data.usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens || 0 } };
    const choice = data.choices?.[0]; if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string") addReasoning(reasoning);
    if (delta.refusal) addText(delta.refusal);
    if (typeof delta.content === "string") addText(delta.content);
    for (const [position, tool] of (delta.tool_calls || []).entries()) {
      const index = tool.index ?? position;
      if (!Number.isInteger(index) || index < 0 || index > 255) throw apiError("invalid_stream", "工具调用索引无效");
      const call = calls.get(index) || { id: "", name: "", arguments: "" };
      if (tool.id) call.id += tool.id;
      if (tool.function?.name) call.name += tool.function.name;
      if (tool.function?.arguments) call.arguments += tool.function.arguments;
      calls.set(index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (/application\/json/i.test(upstream.headers.get("content-type") || "")) chunk(await readApiJson(upstream));
  else for await (const data of apiEvents(upstream)) { if (data.done) break; chunk(data); }
  if (!finish) throw apiError("incomplete_stream", "第三方接口流式响应中断，未收到结束标记");
  if (!["stop", "tool_calls", "length"].includes(finish)) throw apiError("provider", "第三方模型未正常完成请求：" + finish);
  if (finish === "stop" && !textItem?.content[0]?.text.trim() && !calls.size)
    throw apiError("empty_response", "第三方接口未返回回复正文，请检查模型、额度或稍后重试");
  if (reasoningItem) {
    const data = { item_id: reasoningItem.id, output_index: output.indexOf(reasoningItem), summary_index: 0 };
    emit("response.reasoning_summary_text.done", { ...data, text: reasoningItem.summary[0].text });
    emit("response.reasoning_summary_part.done", { ...data, part: reasoningItem.summary[0] });
    emit("response.output_item.done", { output_index: output.indexOf(reasoningItem), item: reasoningItem });
  }
  if (textItem) {
    textItem.status = "completed";
    emit("response.output_text.done", { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, text: textItem.content[0].text });
    emit("response.content_part.done", { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, part: textItem.content[0] });
    emit("response.output_item.done", { output_index: output.indexOf(textItem), item: textItem });
  }
  // Never publish a partially generated tool call for execution.
  if (finish !== "length") for (const call of calls.values()) {
    if (!call.id || !request.tools?.some((t) => t.function.name === call.name)) throw apiError("invalid_tool", "第三方接口返回了未声明的工具调用");
    let args; try { args = JSON.parse(call.arguments); } catch { throw apiError("invalid_tool", "第三方接口返回了无效的工具参数"); }
    if (custom.has(call.name) && typeof args?.input !== "string") throw apiError("invalid_tool", "自定义工具缺少 input 字符串");
    const output_index = output.length, item = { id: "fc_" + crypto.randomBytes(10).toString("hex"),
      type: custom.has(call.name) ? "custom_tool_call" : "function_call", call_id: call.id, ...toolMap.get(call.name), status: "completed",
      ...(custom.has(call.name) ? { input: args.input } : { arguments: call.arguments }) };
    output.push(item);
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress", ...(custom.has(call.name) ? { input: "" } : { arguments: "" }) } });
    const stem = custom.has(call.name) ? "response.custom_tool_call_input" : "response.function_call_arguments";
    emit(stem + ".delta", { item_id: item.id, output_index, delta: custom.has(call.name) ? args.input : call.arguments });
    emit(stem + ".done", { item_id: item.id, output_index, ...(custom.has(call.name) ? { input: args.input } : { arguments: call.arguments }) });
    emit("response.output_item.done", { output_index, item });
  }
  const result = response(finish === "length" ? "incomplete" : "completed");
  if (finish === "length") result.incomplete_details = { reason: "max_output_tokens" };
  if (streaming) { emit(finish === "length" ? "response.incomplete" : "response.completed", { response: result }); res.end(); }
  else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); }
}

export async function startChatAdapter(config) {
  const token = crypto.randomBytes(32).toString("hex"), active = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); res.end(); return; }
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    const controller = new AbortController(); active.add(controller);
    req.on("aborted", () => controller.abort()); res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > 16 << 20) throw apiError("too_large", "任务上下文超过适配器限制"); chunks.push(chunk);
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw apiError("invalid_json", "请求不是有效的 JSON"); }
      await bridge(body, config, res, controller.signal);
    } catch (e) {
      const error = { type: e.code || "api_error", message: safeApiMessage(e, config.apiKey), code: e.code || "api_error" };
      if (!res.destroyed) {
        if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); }
        else res.end(`event: error\ndata: ${JSON.stringify({ ...error, type: "error" })}\n\n`);
      }
    } finally { controller.abort(); active.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}/v1`, token,
    close() { for (const controller of active) controller.abort(); server.closeAllConnections(); server.close(); } };
}
