// Shared, bounded provider I/O. Never follow redirects with a provider credential.
export function apiError(code, message, status = 0) {
  return Object.assign(new Error(message), { code, upstreamStatus: status });
}

export function safeApiMessage(error, key = "") {
  let s = String(error?.message || "API 请求失败");
  if (key) s = s.replaceAll(key, "[redacted]");
  return s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}

export async function readApiJson(response, max = 2 << 20) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw apiError("too_large", "接口返回内容过大");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw apiError("invalid_json", "接口没有返回有效的 JSON，请确认 API 地址"); }
}

export async function providerRequest(config, suffix, { body, signal, timeoutMs = 20000 } = {}) {
  const url = config.baseUrl + suffix;
  const deadline = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, { method: body ? "POST" : "GET", redirect: "manual",
      headers: { accept: body?.stream ? "text/event-stream, application/json" : "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(config.apiKey && !config.noKey ? { authorization: "Bearer " + config.apiKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (e) {
    if (signal?.aborted) throw apiError("cancelled", "请求已取消");
    if (deadline.aborted) throw apiError("timeout", "接口请求超时，请检查地址与网络");
    throw apiError("network", "无法连接接口，请检查域名、证书和网络");
  }
  if (response.ok && !/text\/html|application\/xhtml/i.test(response.headers.get("content-type") || "")) return response;
  const status = response.status;
  if (status >= 300 && status < 400) {
    await response.body?.cancel();
    throw apiError("redirect", "接口返回重定向，请填写最终 API 地址；密钥未转发", status);
  }
  if (/text\/html|application\/xhtml/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    throw apiError("html", "返回的是网页，请使用服务商提供的 API 基础地址，通常包含 /v1", status);
  }
  let detail = "";
  try { const data = await readApiJson(response, 65536); detail = typeof data.error?.message === "string" ? data.error.message : ""; } catch {}
  if (status === 401 || status === 403) throw apiError("auth", "鉴权或访问被拒绝，请检查 API Key、权限与服务商防火墙", status);
  if (status === 404) throw apiError("not_found", detail ? "接口或模型不存在：" + safeApiMessage({ message: detail }, config.apiKey) : "接口不存在，请检查基础地址、协议与模型名称", status);
  if (status === 429) throw apiError("rate_limit", "接口限流或额度不足，请检查服务商账户", status);
  throw apiError("http", detail ? safeApiMessage({ message: detail }, config.apiKey) : "接口请求失败（HTTP " + status + "）", status);
}

export async function* apiEvents(response, max = 32 << 20) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", size = 0;
  function parse(block) {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return null;
    if (data === "[DONE]") return { done: true };
    try { return JSON.parse(data); } catch { throw apiError("invalid_stream", "接口返回了无效的流式数据"); }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) size += value.length;
      if (size > max) throw apiError("too_large", "接口返回内容过大");
      buffer += decoder.decode(value, { stream: !done });
      // CRLF can straddle network chunks. Normalize only complete lines.
      let end;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, end.index).replaceAll("\r\n", "\n");
        buffer = buffer.slice(end.index + end[0].length);
        const event = parse(block); if (event) yield event;
      }
      if (buffer.length > 2 << 20) throw apiError("too_large", "单条流式事件过大");
      if (done) { if (buffer.trim()) { const event = parse(buffer.replaceAll("\r\n", "\n")); if (event) yield event; } break; }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
