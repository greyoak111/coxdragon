import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { updateConnection, connectionStatus, connectionDraft, normalizeApiUrl, prepareConnectionLaunch } from "../gw/codex-connection.mjs";
import { discoverApiModels, testApiConnection } from "../gw/codex-api.mjs";
import { apiEvents } from "../gw/codex-api-http.mjs";
import { startChatAdapter, toChatRequest } from "../gw/codex-chat-adapter.mjs";

const key = "synthetic-api-key-not-a-real-credential";
async function server(fn) {
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const entry = { url: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : null };
    requests.push(entry);
    try { await fn(req, res, entry); } catch (e) { res.destroy(e); }
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, requests,
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const html = (res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<!doctype html><title>页面不存在 CodeFlow</title>"); };
const sse = (res, chunks) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const chunk of chunks) res.write("data: " + JSON.stringify(chunk) + "\r\n\r\n"); res.end("data: [DONE]\r\n\r\n"); };
const draft = (baseUrl, extra = {}) => ({ mode: "custom", baseUrl, model: "fixture-model", apiKey: key, wireApi: "auto", ...extra });
after(() => updateConnection({ mode: "chatgpt" }));

test("API：升级迁移旧 CodeFlow DeepSeek Responses，保留密钥，尊重新版显式协议及其他服务", async () => {
  const file = path.join(CFG.home, "coxdragon-codex-connection.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const cases = [
    [{ baseUrl: "https://codeflow.sh/v1", model: "deepseek-ai/DeepSeek-V4.1-Flash" }, "chat"],
    [{ baseUrl: "https://codeflow.sh/v1", model: "deepseek-ai/DeepSeek-V4.1-Flash", compatibilityVersion: 1 }, "responses"],
    [{ baseUrl: "https://other-provider.test/v1", model: "deepseek-chat" }, "responses"],
    [{ baseUrl: "https://codeflow.sh/v1", model: "gpt-test-model" }, "responses"],
  ];
  try {
    for (const [index, [overrides, expected]] of cases.entries()) {
      fs.writeFileSync(file, JSON.stringify({ mode: "custom", wireApi: "responses", apiKey: key, ...overrides }));
      const migrated = await import("../gw/codex-connection.mjs?migration=" + index);
      assert.equal(migrated.connectionStatus().wireApi, expected);
      const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(persisted.apiKey, key); assert.equal(persisted.wireApi, expected);
      assert.equal(JSON.stringify(migrated.connectionStatus()).includes(key), false);
      if (expected === "chat") assert.equal(persisted.compatibilityVersion, 1);
    }
  } finally { if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true }); }
});

test("API：完整端点规范化，旧配置保留 Responses，检测不保存密钥或配置", async () => {
  for (const suffix of ["/responses", "/models/", "/chat/completions"])
    assert.equal(normalizeApiUrl("https://provider.test/v1" + suffix), "https://provider.test/v1");
  assert.throws(() => connectionDraft(draft("https://provider.test/v1", { wireApi: "anthropic" })), /协议/);
  updateConnection(draft("https://provider.test/v1", { wireApi: "responses" }));
  assert.equal(connectionDraft({ baseUrl: "https://provider.test/v1", model: "m" }).apiKey, key);
  assert.throws(() => connectionDraft({ baseUrl: "https://other.test/v1", model: "m" }), /API Key/);
  const file = path.join(CFG.home, "coxdragon-codex-connection.json"), before = fs.readFileSync(file, "utf8");
  const api = await server((req, res) => json(res, { data: [{ id: "z" }, { id: "a" }, { id: "a" }, { id: "bad\nmodel" }, { id: 17 }] }));
  try {
    const result = await discoverApiModels(draft(api.url));
    assert.equal(result.ok, true); assert.equal(result.baseUrl, api.url + "/v1"); assert.deepEqual(result.models, ["a", "z"]);
    assert.equal(api.requests[0].auth, "Bearer " + key);
    assert.equal(fs.readFileSync(file, "utf8"), before); assert.equal(JSON.stringify(result).includes(key), false);
  } finally { await api.close(); }
});

test("API：模型列表检测网页、路径回退、空列表及无需密钥接口", async () => {
  const api = await server((req, res) => req.url === "/v1/models" ? html(res) : json(res, { models: ["local-model"] }));
  try {
    const result = await discoverApiModels(draft(api.url, { apiKey: "", noKey: true }));
    assert.equal(result.ok, true); assert.equal(result.attempts[0].code, "html"); assert.equal(result.baseUrl, api.url);
    assert.equal(api.requests.some((r) => r.auth), false);
  } finally { await api.close(); }
  const empty = await server((req, res) => json(res, { data: [] }));
  try { const result = await discoverApiModels(draft(empty.url)); assert.equal(result.ok, false); assert.equal(result.attempts[0].code, "empty_models"); }
  finally { await empty.close(); }
});

test("API：提供商模型发现失败仍返回 models.dev 能力，不暴露密钥或伪造模型列表",async()=>{
  const api=await server((req,res)=>html(res));
  try{
    const result=await discoverApiModels(draft(api.url,{model:"openai/gpt-5"}));
    assert.equal(result.ok,false);assert.deepEqual(result.models,[]);assert.equal(result.metadataSource,"models.dev/cache");
    const model=result.modelDetails.find(m=>m.id==="openai/gpt-5");assert(model?.contextWindow>0);assert.equal(model.capabilitySources.context,"models.dev");
    assert(model.supportedReasoningEfforts.length>0);assert.equal(JSON.stringify(result).includes(key),false);
  }finally{await api.close();}
});

test("API：自动识别从网页 404 转到 Chat Completions，验证实际流式完成与耗时", async () => {
  const api = await server((req, res) => req.url.endsWith("/responses") ? html(res) : sse(res, [
    { choices: [{ delta: { content: "OK" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]));
  try {
    const result = await testApiConnection(draft(api.url));
    assert.equal(result.ok, true); assert.equal(result.wireApi, "chat"); assert.equal(result.baseUrl, api.url + "/v1");
    assert.equal(result.attempts.length, 2); assert.equal(result.attempts[0].code, "html"); assert(result.elapsedMs >= 0);
    assert.equal(api.requests[1].body.messages[0].content, "Reply OK."); assert.equal(api.requests[1].body.max_tokens, 256);
  } finally { await api.close(); }
});

test("API：Responses 真实完成回包，不能把网页或截断流判为测试成功", async () => {
  const good = await server((req, res) => sse(res, [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]));
  try { assert.equal((await testApiConnection(draft(good.url))).wireApi, "responses"); } finally { await good.close(); }
  const truncated = await server((req, res) => sse(res, [{ type: "response.created", response: { status: "in_progress" } }]));
  try { const result = await testApiConnection(draft(truncated.url)); assert.equal(result.ok, false); assert.equal(result.attempts[0].code, "incomplete_stream"); }
  finally { await truncated.close(); }
  const page = await server((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>wrong endpoint</html>"); });
  try { const result = await testApiConnection(draft(page.url, { wireApi: "responses" })); assert.equal(result.ok, false); assert.equal(result.message.includes("<html>"), false); }
  finally { await page.close(); }
});

test("API：DeepSeek 自动选择 Chat，显式协议优先，Responses 检测携带工具上下文", async () => {
  const api = await server((req, res, entry) => req.url.endsWith("/chat/completions")
    ? sse(res, [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }])
    : sse(res, [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]));
  try {
    const automatic = await testApiConnection(draft(api.url, { model: "deepseek-ai/DeepSeek-V4.1-Flash" }));
    assert.equal(automatic.wireApi, "chat"); assert.equal(api.requests.length, 1);
    const explicit = await testApiConnection(draft(api.url, { model: "deepseek-chat", wireApi: "responses" }));
    assert.equal(explicit.wireApi, "responses");
    assert.equal(api.requests[1].body.input[0].role, "user");
    assert.equal(api.requests[1].body.tools[0].type, "custom"); assert.equal(api.requests[1].body.tool_choice, "none");
  } finally { await api.close(); }
});

test("API：空完成事件、仅思考及输出截断都不能通过连通测试", async () => {
  for (const wireApi of ["responses", "chat"]) {
    const api = await server((req, res) => sse(res, wireApi === "responses"
      ? [{ type: "response.completed", response: { status: "completed", output: [] } }]
      : [{ choices: [{ delta: { reasoning_content: "thinking only" }, finish_reason: "stop" }] }]));
    try { const result = await testApiConnection(draft(api.url, { wireApi })); assert.equal(result.ok, false); assert.equal(result.attempts[0].code, "empty_response"); }
    finally { await api.close(); }
  }
});

test("API：鉴权失败不重试协议，重定向不转发密钥，上游错误不泄露凭据", async () => {
  const denied = await server((req, res) => json(res, { error: { message: "echo " + key } }, 401));
  try {
    const result = await testApiConnection(draft(denied.url)); assert.equal(result.ok, false); assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].code, "auth"); assert.equal(JSON.stringify(result).includes(key), false);
  } finally { await denied.close(); }
  const destination = await server((req, res) => json(res, {}));
  const redirected = await server((req, res) => { res.writeHead(307, { location: destination.url }); res.end(); });
  try {
    const result = await discoverApiModels(draft(redirected.url)); assert.equal(result.attempts[0].code, "redirect"); assert.equal(destination.requests.length, 0);
  } finally { await redirected.close(); await destination.close(); }
  const echoed = await server((req, res) => json(res, { error: { message: "invalid " + key } }, 400));
  try { assert.equal(JSON.stringify(await testApiConnection(draft(echoed.url))).includes(key), false); } finally { await echoed.close(); }
});

test("API：超时有界、请求可以取消", async () => {
  const stalled = await server(() => {});
  try {
    const result = await discoverApiModels(draft(stalled.url), { timeoutMs: 30 }); assert.equal(result.attempts[0].code, "timeout");
    const controller = new AbortController();
    const promise = testApiConnection(draft(stalled.url), { signal: controller.signal }); controller.abort();
    assert.equal((await promise).attempts[0].code, "cancelled");
  } finally { await stalled.close(); }
});

test("Chat 适配：完整上下文、图片、函数与自定义工具往返；不伪造不支持的能力", () => {
  const { request, custom } = toChatRequest({ model: "fixture", instructions: "instructions", tools: [
    { type: "function", name: "read", parameters: { type: "object" } }, { type: "custom", name: "apply_patch" },
  ], input: [
    { role: "developer", content: [{ type: "input_text", text: "rules" }] },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "patch" },
    { type: "function_call_output", call_id: "c1", output: "file" },
    { type: "custom_tool_call_output", call_id: "c2", output: "done" },
  ] });
  assert.equal(request.messages[0].role, "system"); assert.equal(request.messages[1].role, "system");
  assert.equal(request.messages[2].content[0].type, "image_url"); assert.equal(request.messages[3].tool_calls.length, 2);
  assert.equal(request.messages[4].tool_call_id, "c1"); assert.equal(request.messages[5].content, "done"); assert(custom.has("apply_patch"));
  assert.equal(JSON.stringify(request).includes("opaque"), false);
  assert.throws(() => toChatRequest({ tools: [{ type: "web_search" }] }), /不支持/);
  assert.throws(() => toChatRequest({ input: [{ type: "compaction" }] }), /不支持/);
});

test("Chat 适配：认证回环、真实流、工具参数拼接及上游 Key 隔离", async () => {
  const api = await server((req, res) => sse(res, [
    { choices: [{ delta: { content: "你好" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_one", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
  ]));
  const adapter = await startChatAdapter(draft(api.url + "/v1", { wireApi: "chat" }));
  try {
    const denied = await fetch(adapter.url + "/responses", { method: "POST", body: "{}" }); assert.equal(denied.status, 401);
    const response = await fetch(adapter.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + adapter.token }, body: JSON.stringify({ model: "fixture", stream: true,
      input: "read file", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }) });
    const events = []; for await (const event of apiEvents(response)) events.push(event);
    assert(events.some((e) => e.type === "response.output_text.delta" && e.delta === "你好"));
    const result = events.at(-1).response; assert.equal(result.status, "completed");
    assert.equal(result.output[1].call_id, "call_one"); assert.equal(result.output[1].arguments, '{"path":"file"}'); assert.equal(result.usage.total_tokens, 17);
    assert.equal(api.requests[0].url, "/v1/chat/completions"); assert.equal(api.requests[0].auth, "Bearer " + key);
    assert.equal(JSON.stringify(events).includes(key), false);
  } finally { adapter.close(); await api.close(); }
});

test("Chat 适配：Codex 命名空间工具保留路由信息，名称映射在历史中保持稳定", () => {
  const { request, toolMap } = toChatRequest({ input: [{ type: "function_call", namespace: "multi_agent_v1", name: "wait_agent", call_id: "call_ns", arguments: "{}" }],
    tools: [{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "wait_agent", parameters: { type: "object" } }] }] });
  const encoded = request.tools[0].function.name;
  assert.match(encoded, /^[A-Za-z0-9_-]{1,64}$/); assert.equal(request.messages[0].tool_calls[0].function.name, encoded);
  assert.deepEqual(toolMap.get(encoded), { namespace: "multi_agent_v1", name: "wait_agent" });
});

test("Chat 适配：保留第三方思考文本、正文流和工具的独立索引，空回复不误报成功", async () => {
  const api = await server((req, res) => sse(res, [
    { choices: [{ delta: { reasoning_content: "provider thinking" } }] },
    { choices: [{ delta: { content: "answer" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]));
  const adapter = await startChatAdapter(draft(api.url, { wireApi: "chat" }));
  try {
    const response = await fetch(adapter.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + adapter.token }, body: JSON.stringify({ model: "fixture", input: "test", tools: [{ type: "function", name: "read" }] }) });
    const events = []; for await (const event of apiEvents(response)) events.push(event);
    assert(events.some((e) => e.type === "response.reasoning_summary_text.delta" && e.delta === "provider thinking"));
    assert.equal(events.find((e) => e.type === "response.output_text.delta").output_index, 1);
    assert.deepEqual(events.at(-1).response.output.map((i) => i.type), ["reasoning", "message", "function_call"]);
    assert.equal(events.at(-1).response.output[0].summary[0].text, "provider thinking");
  } finally { adapter.close(); await api.close(); }
  const empty = await server((req, res) => sse(res, [{ choices: [{ delta: { reasoning_content: "thinking only" }, finish_reason: "stop" }] }]));
  const emptyAdapter = await startChatAdapter(draft(empty.url, { wireApi: "chat" }));
  try {
    const response = await fetch(emptyAdapter.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + emptyAdapter.token }, body: JSON.stringify({ model: "fixture", input: "test" }) });
    const events = []; for await (const event of apiEvents(response)) events.push(event);
    assert.equal(events.at(-1).code, "empty_response"); assert.equal(events.some((e) => e.type === "response.completed"), false);
  } finally { emptyAdapter.close(); await empty.close(); }
});

test("Chat 适配：自定义工具生成、截断流与无效参数不会误报成功或发布可执行工具", async () => {
  for (const [mode, expected] of [["custom", "response.completed"], ["truncated", "error"], ["invalid", "error"]]) {
    const api = await server((req, res) => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "apply_patch", arguments: mode === "invalid" ? "bad" : '{"input":"patch"}' } }] }, ...(mode === "truncated" ? {} : { finish_reason: "tool_calls" }) }] }]));
    const adapter = await startChatAdapter(draft(api.url, { wireApi: "chat" }));
    try {
      const response = await fetch(adapter.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + adapter.token }, body: JSON.stringify({ model: "fixture", stream: true, input: "patch", tools: [{ type: "custom", name: "apply_patch" }] }) });
      const events = []; for await (const event of apiEvents(response)) events.push(event);
      if (mode === "custom") { assert.equal(events.at(-1).type, expected); assert.equal(events.at(-1).response.output[0].input, "patch"); }
      else { assert(events.at(-1).code); assert.equal(events.some((e) => e.type === "response.completed" || e.type === "response.output_item.done"), false); }
    } finally { adapter.close(); await api.close(); }
  }
});

test("Chat 适配：启动引擎时注入的是回环令牌，关闭后接口不再可用", async () => {
  updateConnection(draft("https://provider.test/v1", { wireApi: "chat" }));
  assert.equal(connectionStatus().wireApi, "chat"); assert.equal(JSON.stringify(connectionStatus()).includes(key), false);
  const launch = await prepareConnectionLaunch();
  try {
    assert.notEqual(launch.env.COXDRAGON_CUSTOM_API_KEY, key); assert.equal(launch.args.join(" ").includes("https://provider.test"), false);
    assert(launch.args.some((s) => s.includes('base_url="http://127.0.0.1:')));
    assert(launch.args.includes('web_search="disabled"'));
    assert(launch.args.includes('model_providers.coxdragon_custom.stream_max_retries=0'));
  } finally { launch.close(); }
});

test("Chat 适配：后续工具参数损坏时整批拒绝，不能先发布合法工具", async () => {
  for (const broken of ["invalid-json", "unknown-tool", "missing-custom-input"]) {
    const api = await server((req, res) => sse(res, [{ choices: [{ delta: { tool_calls: [
      { index: 0, id: "valid", function: { name: "write", arguments: "{}" } },
      { index: 1, id: "broken", function: { name: broken === "unknown-tool" ? "undeclared" : "apply_patch", arguments: broken === "invalid-json" ? "bad" : "{}" } },
    ] }, finish_reason: "tool_calls" }] }]));
    const adapter = await startChatAdapter(draft(api.url, { wireApi: "chat" }));
    try {
      const response = await fetch(adapter.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + adapter.token },
        body: JSON.stringify({ model: "fixture", input: "test", tools: [{ type: "function", name: "write" }, { type: "custom", name: "apply_patch" }] }) });
      const events = []; for await (const event of apiEvents(response)) events.push(event);
      assert.equal(events.at(-1).code, "invalid_tool");
      assert.equal(events.some((e) => e.item?.type === "function_call" || e.item?.type === "custom_tool_call"), false);
      assert.equal(events.some((e) => e.type === "response.completed"), false);
    } finally { adapter.close(); await api.close(); }
  }
});
