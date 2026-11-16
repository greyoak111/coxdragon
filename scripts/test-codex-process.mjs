// Pinned app-server process + synthetic loopback provider. No real model/account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.CODEX_TEST_BIN || path.join(root, ".cache", process.platform === "win32" ? "codex-app-server-test.exe" : "codex-app-server");
assert.match(spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true }).stdout || "", /\b0\.166\.0\b/, "Install pinned codex-app-server 0.166.0 or set CODEX_TEST_BIN");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "coxdragon-process-test-"));
Object.assign(process.env, { CCAPP_TEST: "1", CCAPP_HOME: temporary, CCAPP_WORKSPACE: temporary, CCAPP_LOG: path.join(temporary, "gateway.log") });
const { updateConnection, prepareConnectionLaunch } = await import("../gateway/gw/codex-connection.mjs");
const { rememberApiModels } = await import("../gateway/gw/codex-models.mjs");
const { readThreadUsage } = await import("../gateway/gw/codex-context.mjs");
const marker = path.join(temporary, "executed.txt");
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const command = process.platform === "win32" ? `Add-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'executed'` : `printf '%s\\n' executed >> ${quote(marker)}`;
const executionCount = () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split(/\r?\n/).filter(Boolean).length : 0;
let mode = "responses", requests = [], adapterClose;
const drivers = [], results = [];
const server = http.createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
    const text = "SYNTHETIC_PROCESS_OK";
    const tool = { index: 0, id: "call_fixture", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ cmd: command, max_output_tokens: 100 }) } };
    if (mode === "responses" || mode === "responses-interrupted") {
      const id = "response_" + requests.length;
      send({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
      const item = mode === "responses-interrupted" && requests.length === 1
        ? { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "exec_command", arguments: tool.function.arguments, status: "completed" }
        : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
      if (item.type === "message") send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text });
      send({ type: "response.output_item.done", output_index: 0, item });
      // Fail the response AFTER the preceding request's tool has executed.
      if (!(mode === "responses-interrupted" && requests.length > 1)) send({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    } else {
      assert.equal(body.stream_options?.include_usage,true,"流式 Chat 请求要求服务商返回 usage");
      assert(body.tools.some(tool => tool.function.name === "exec_command"));
      assert.equal(body.reasoning_effort, "high", "Chat 适配器保留所选思考强度");
      send({ choices: [{ delta: { reasoning_content: "Synthetic reasoning summary." }, finish_reason: null }] });
      if ((mode === "chat-valid" || mode === "chat-approval") && requests.length > 1) {
        assert(body.messages.some(message => message.role === "tool" && message.tool_call_id === "call_fixture"));
        send({ choices: [{ delta: { content: text }, finish_reason: "stop" }] });
      } else {
        const calls = [tool];
        if (mode === "chat-invalid-json") calls.push({ ...tool, index: 1, id: "call_invalid", function: { name: "exec_command", arguments: "truncated-json" } });
        if (mode === "chat-unknown-tool") calls.push({ ...tool, index: 1, id: "call_invalid", function: { name: "nonexistent_tool", arguments: "{}" } });
        send({ choices: [{ delta: { tool_calls: calls }, finish_reason: mode === "chat-truncated" ? null : "tool_calls" }] });
      }
      if (mode !== "chat-truncated") {
        send({choices:[],usage:{prompt_tokens:800,completion_tokens:100,total_tokens:900,prompt_tokens_details:{cached_tokens:600}}});
        res.write("data: [DONE]\n\n");
      }
    }
    res.end();
  } catch (error) { res.destroy(error); }
});

class Driver {
  constructor(launch) {
    this.events = []; this.pending = new Map(); this.seq = 0; this.buffer = ""; this.stderr = "";
    // Only OS/runtime essentials survive. Provider credentials and user config cannot leak.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LOCALAPPDATA)$/i.test(key)));
    Object.assign(env, launch.env, { HOME: temporary, USERPROFILE: temporary, CODEX_HOME: path.join(temporary, ".codex"), HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" });
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    this.child = spawn(binary, [...launch.args, "--listen", "stdio://"], { env, cwd: temporary, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise(resolve => this.child.once("close", resolve));
    this.child.stderr.on("data", data => { this.stderr = (this.stderr + data).slice(-3000); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", data => {
      this.buffer += data; let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch (error) { this.fail(error); continue; }
        const pending = this.pending.get(event.id);
        if (pending) { this.pending.delete(event.id); clearTimeout(pending.timer); event.error ? pending.reject(new Error(event.error.message)) : pending.resolve(event.result); }
        else this.events.push(event);
      }
    });
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", code => this.fail(new Error("app-server exited: " + code)));
    drivers.push(this);
  }
  fail(error) { this.failure = error; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.pending.delete(id); reject(new Error("RPC timeout: " + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) this.fail(error); });
    });
  }
  async init() { await this.request("initialize", { clientInfo: { name: "coxdragon_process_test", version: "1" }, capabilities: { experimentalApi: true } }); }
  async turn(threadId, extra = {}) {
    const { turn } = await this.request("turn/start", { threadId, input: [{ type: "text", text: "synthetic fixture" }], ...extra });
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      const result = this.events.find(event => event.method === "turn/completed" && event.params.turn.id === turn.id);
      if (result) return result.params.turn;
      if (this.failure) throw this.failure;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Turn timeout " + this.stderr);
  }
  async stop() {
    if (this.child.exitCode == null && this.child.signalCode == null) { this.child.stdin.end(); this.child.kill(); }
    await this.closed;
  }
}

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  rememberApiModels(baseUrl, [{ id: "process-fixture", contextWindow: 64000, supportedReasoningEfforts: ["high"] }]);
  async function start(wireApi, permission = { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" }) {
    updateConnection({ mode: "custom", baseUrl, model: "process-fixture", noKey: true, wireApi, effort: "high" });
    const launch = await prepareConnectionLaunch(); adapterClose = launch.close;
    const driver = new Driver(launch); await driver.init();
    const response = await driver.request("thread/start", { cwd: temporary, model: "process-fixture", modelProvider: launch.modelProvider, ...permission });
    return { driver, thread:response.thread, launch, response };
  }
  const first = await start("responses");
  assert.equal((await first.driver.turn(first.thread.id)).status, "completed");
  const usage = first.driver.events.find(event => event.method === "thread/tokenUsage/updated");
  assert(usage?.params.tokenUsage.last.totalTokens > 0, "实际引擎报告最近请求 token 数");
  assert(usage.params.tokenUsage.modelContextWindow > 0 && usage.params.tokenUsage.modelContextWindow <= 64000, "使用所选模型上限而非引擎默认值");
  assert.equal(requests[0].reasoning?.effort, "high", "所选思考强度发送到真实 Responses 请求");
  const persisted=await first.driver.request("thread/read",{threadId:first.thread.id,includeTurns:false});
  const restored=await readThreadUsage(persisted.thread.path,path.join(temporary,".codex","sessions"),first.thread.id);
  assert(restored?.last.totalTokens>0,"真实引擎 jsonl 能恢复上下文");
  assert.equal(restored.last.totalTokens,usage.params.tokenUsage.last.totalTokens);
  results.push("restored actual engine transcript usage without a frontend cache");
  await first.driver.request("thread/compact/start", { threadId: first.thread.id });
  const compactEnd = Date.now() + 20000;
  while (Date.now() < compactEnd && !first.driver.events.some(event => event.method === "item/completed" && event.params.item.type === "contextCompaction")) await new Promise(resolve => setTimeout(resolve, 50));
  assert(first.driver.events.some(event => event.method === "item/started" && event.params.item.type === "contextCompaction"), "实际压缩开始事件");
  assert(first.driver.events.some(event => event.method === "item/completed" && event.params.item.type === "contextCompaction"), "实际压缩完成事件");
  results.push("real context usage and manual context compaction lifecycle");
  await first.driver.stop();
  const second = new Driver(first.launch); await second.init();
  await assert.rejects(second.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "before resume" }] }), /thread.*not found/i);
  await second.request("thread/resume", { threadId: first.thread.id, modelProvider: first.launch.modelProvider, approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal((await second.turn(first.thread.id)).status, "completed");
  await second.stop(); results.push("persisted thread resumes in a new engine process");

  for(const [name,sandbox,approvalPolicy,approvalsReviewer,policyType] of [["read","read-only","never","user","readOnly"],["ask","danger-full-access","untrusted","user","dangerFullAccess"],["auto","danger-full-access","untrusted","auto_review","dangerFullAccess"],["full","danger-full-access","never","user","dangerFullAccess"]]){
    mode="responses";requests=[];
    const {driver,response}=await start("responses",{sandbox,approvalPolicy,approvalsReviewer});
    assert.equal(response.sandbox.type,policyType,name+": actual engine sandbox "+response.sandbox.type);
    assert.equal(response.approvalPolicy,approvalPolicy);assert.equal(response.approvalsReviewer,approvalsReviewer);
    results.push({permission:name,effectiveSandbox:response.sandbox.type,reviewer:response.approvalsReviewer});await driver.stop();
  }
  results.push("real engine accepts all four permission policies and automatic approval reviewer");

  mode="chat-valid";requests=[];fs.rmSync(marker,{force:true});
  const readOnly=await start("chat",{sandbox:"read-only",approvalPolicy:"never",approvalsReviewer:"user"});
  await readOnly.driver.turn(readOnly.thread.id,{sandboxPolicy:{type:"readOnly",networkAccess:false},approvalPolicy:"never",approvalsReviewer:"user"});
  await readOnly.driver.stop();adapterClose?.();adapterClose=null;
  assert.equal(executionCount(),0,"read-only sandbox cannot execute a write to the workspace");
  results.push("read-only policy prevents a real tool from writing to the workspace");

  for(const decision of ["decline","accept"]){
    mode="chat-approval";requests=[];fs.rmSync(marker,{force:true});
    const probe=await start("chat",{sandbox:"danger-full-access",approvalPolicy:"untrusted",approvalsReviewer:"user"});
    const completion=probe.driver.turn(probe.thread.id);
    const deadline=Date.now()+15000;
    while(Date.now()<deadline&&!probe.driver.events.some(e=>e.method==="item/commandExecution/requestApproval"))await new Promise(resolve=>setTimeout(resolve,20));
    const approval=probe.driver.events.find(e=>e.method==="item/commandExecution/requestApproval");
    assert(approval,"risky command must await user approval");assert.equal(executionCount(),0,"command cannot run before user approval");
    probe.driver.child.stdin.write(JSON.stringify({id:approval.id,result:{decision}})+"\n");
    await completion;await probe.driver.stop();adapterClose?.();adapterClose=null;
    assert.equal(executionCount(),decision==="accept"?1:0,"approval decision controls real command execution");
    results.push({permission:"ask",decision,executedCommands:executionCount()});
  }

  for (const scenario of ["chat-valid", "chat-invalid-json", "chat-unknown-tool", "chat-truncated", "responses-interrupted"]) {
    mode = scenario; requests = []; fs.rmSync(marker, { force: true });
    const { driver, thread } = await start(scenario.startsWith("responses") ? "responses" : "chat");
    const completed = await driver.turn(thread.id);
    await driver.stop(); adapterClose?.(); adapterClose = null;
    const valid = scenario === "chat-valid", interrupted = scenario === "responses-interrupted";
    assert.equal(completed.status, valid ? "completed" : "failed", scenario + ": status");
    assert.equal(requests.length, valid || interrupted ? 2 : 1, scenario + ": no automatic stream replay");
    assert.equal(executionCount(), valid || interrupted ? 1 : 0, scenario + ": command count");
    if (valid) {
      assert(driver.events.some(event => event.method === "item/reasoning/summaryTextDelta" && event.params.delta.includes("Synthetic reasoning summary.")));
      const reported=driver.events.filter(event=>event.method==="thread/tokenUsage/updated").at(-1)?.params.tokenUsage;
      assert.equal(reported.last.inputTokens,800);assert.equal(reported.last.outputTokens,100);assert.equal(reported.last.cachedInputTokens,600);
      results.push("real Chat adapter usage and cache hits reach native tokenUsage events");
    }
    results.push({ scenario, status: completed.status, providerRequests: requests.length, executedCommands: executionCount() });
  }
  console.log(JSON.stringify({ pinnedAppServer: "0.166.0", realProcess: true, realModelCalls: 0, results }, null, 2));
} finally {
  adapterClose?.();
  for (const driver of drivers) await driver.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const checked = path.resolve(temporary);
  if (!checked.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(checked).startsWith("coxdragon-process-test-")) throw new Error("Unsafe cleanup");
  fs.rmSync(checked, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
