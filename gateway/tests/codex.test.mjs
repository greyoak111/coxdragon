import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG, PREFIX } from "../gw/config.mjs";
import { activityBusy, runFlag } from "../gw/activity.mjs";
import { _codexForTest as cx, codexActivity, onCodexActivity } from "../gw/codex.mjs";
import { connectionStatus, connectionLaunch, connectionProfiles,deleteConnectionProfile,connectionModels } from "../gw/codex-connection.mjs";
import { rememberApiModels,modelSettings } from "../gw/codex-models.mjs";

// The legacy status module imports Android usage accounting. This test only reads
// protocol state; its isolated Windows process needs a synthetic UID for that import.
if (process.platform === "win32" && !process.getuid) process.getuid = () => 0;

function reset() {
  cx.stopServer(); runFlag(false);
  cx.S.rpc = { stderr: "", respond() {}, respondError() {} };
  cx.S.child = null; cx.S.starting = null; cx.S.activeThread = { id: "a" }; cx.S.activeTurn = null;
  for (const key of ["runningTurns", "startingTurns", "endedTurns", "approvals", "sse", "loadedThreads", "threadCwds", "operations", "contexts", "compacting"]) cx.S[key].clear();
  // The protocol fixture represents an engine with these two threads loaded.
  cx.S.loadedThreads.add("a"); cx.S.loadedThreads.add("b");
  cx.S.models = []; cx.S.model = ""; cx.S.effort = ""; cx.S.permissionMode = "ask"; cx.S.metrics.clear();
}
after(() => { cx.stopServer(); runFlag(false); });

test("Codex：模型设置支持手动 ID、多提供商切换与按模型记忆，失败不改变连接",()=>{
  reset();
  try{
    cx.setConnection({mode:"custom",baseUrl:"https://profile-one.test/v1",name:"One",model:"first",apiKey:"synthetic-private-key"});const first=connectionStatus().providerId;
    cx.updateSettings({model:"manual-id",contextWindow:96000,effort:"deep",capabilities:{inputModalities:["text","image"],supportedReasoningEfforts:["deep"]}});
    assert.equal(connectionStatus().model,"manual-id");assert(connectionLaunch().args.includes('model_reasoning_effort="deep"'));
    cx.updateSettings({model:"other-id",effort:"",contextWindow:32000});
    cx.updateSettings({model:"manual-id"});assert.equal(connectionStatus().effort,"deep");assert.equal(connectionStatus().contextWindow,96000);
    cx.setConnection({mode:"custom",baseUrl:"https://profile-two.test/v1",model:"second",noKey:true});const second=connectionStatus().providerId;
    assert.notEqual(first,second);assert.equal(JSON.stringify(connectionProfiles()).includes("synthetic-private-key"),false);
    assert.throws(()=>cx.updateSettings({providerId:first,model:"manual-id",effort:"invalid"}),/思考强度/);assert.equal(connectionStatus().providerId,second);
    const result=cx.updateSettings({providerId:first,model:"manual-id"});assert.equal(result.status.connection.providerId,first);assert.equal(connectionStatus().contextWindow,96000);assert.equal(connectionStatus().effort,"deep");
    assert.equal(cx.S.models.find(m=>m.id==="manual-id").capabilitySources.input,"user");
  }finally{cx.stopServer();cx.setConnection({mode:"chatgpt"});}
});

test("Codex：账号模型列表分页，打开设置可在冷模型列表中主动获取",async()=>{
  reset();const calls=[];
  cx.S.rpc.request=async(method,params)=>{calls.push({method,params});return params.cursor?{data:[{id:"page-two",inputModalities:["text","image"]}],nextCursor:null}:{data:[{id:"page-one"}],nextCursor:"next"};};
  const result=await cx.loadModels("chatgpt");assert.equal(result.ok,true);assert.deepEqual(result.models.map(m=>m.id),["page-one","page-two"]);
  assert.equal(calls[1].params.cursor,"next");assert.deepEqual(result.models[1].inputModalities,["text","image"]);
});

test("提供商：多模型独立能力、仅保存保留引擎与聊天，发现候选不取代配置，可删除非当前提供商",()=>{
  reset();const baseUrl="https://provider-directory.test/v1";
  try{
    cx.setConnection({mode:"custom",baseUrl,model:"one",noKey:true,newProvider:true,models:[{id:"one",settings:{contextWindow:64000}},{id:"two",settings:{supportedReasoningEfforts:["deep"],effort:"deep",inputModalities:["text","image"]}}]});
    const first=connectionStatus().providerId;
    assert.deepEqual(connectionModels().map(m=>m.id).sort(),["one","two"]);
    rememberApiModels(baseUrl,[{id:"one"},{id:"candidate"}]);assert.deepEqual(connectionModels().map(m=>m.id).sort(),["one","two"]);
    const rpc={stderr:""};cx.S.rpc=rpc;cx.S.activeThread={id:"preserved"};
    cx.setConnection({mode:"custom",baseUrl,model:"separate",noKey:true,newProvider:true,activate:false,models:[{id:"separate",settings:{contextWindow:32000}}]});
    assert.equal(connectionStatus().providerId,first);assert.equal(cx.S.rpc,rpc);assert.equal(cx.S.activeThread.id,"preserved");
    const second=connectionProfiles().find(p=>p.baseUrl===baseUrl&&p.id!==first).id;
    assert.throws(()=>deleteConnectionProfile(first),/先切换/);deleteConnectionProfile(second);assert.equal(connectionProfiles().some(p=>p.id===second),false);
    cx.updateSettings({model:"two"});assert.equal(connectionStatus().effort,"deep");assert.equal(connectionModels().find(m=>m.id==="two").capabilitySources.input,"user");
    cx.setConnection({mode:"custom",providerId:first,model:"two",noKey:true,models:[{id:"two",settings:{}}]});assert.deepEqual(connectionModels().map(m=>m.id),["two"]);
    assert.throws(()=>cx.setConnection({mode:"custom",providerId:first,model:"two",modelIds:["two","two"],noKey:true}),/模型列表/);
  }finally{cx.stopServer();cx.setConnection({mode:"chatgpt"});}
});

test("提供商：批量模型保存失败完整回滚模型设置和连接",()=>{
  reset();const baseUrl="https://directory-failure.test/v1",file=path.join(CFG.home,"coxdragon-codex-connection.json");
  try{
    cx.setConnection({mode:"custom",baseUrl,model:"existing",noKey:true,models:[{id:"existing",settings:{contextWindow:64000}}]});
    const before=fs.readFileSync(file),settingsBefore=fs.readFileSync(path.join(CFG.home,"coxdragon-model-settings.json"),"utf8");
    fs.rmSync(file);fs.mkdirSync(file);
    try{assert.throws(()=>cx.setConnection({mode:"custom",baseUrl,model:"new-failed",noKey:true,newProvider:true,models:[{id:"existing",settings:{contextWindow:32000}},{id:"new-failed",settings:{contextWindow:48000}}]}),/没有保存/);}
    finally{fs.rmdirSync(file);fs.writeFileSync(file,before);}
    assert.equal(connectionStatus().model,"existing");assert.equal(modelSettings(baseUrl,"existing").contextWindow,64000);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CFG.home,"coxdragon-model-settings.json"),"utf8")),JSON.parse(settingsBefore));
    assert.equal(connectionProfiles().some(p=>p.model==="new-failed"),false);
  }finally{cx.stopServer();cx.setConnection({mode:"chatgpt"});}
});

test("提供商：切回 ChatGPT 后删除上次提供商，同时清除旧格式的密钥副本",()=>{
  reset();const credential="synthetic-delete-profile-credential";
  cx.setConnection({mode:"custom",newProvider:true,baseUrl:"https://delete-credential.test/v1",model:"deleted",apiKey:credential});
  const id=connectionStatus().providerId;cx.setConnection({mode:"chatgpt"});deleteConnectionProfile(id);
  assert.equal(connectionStatus().mode,"chatgpt");assert.equal(connectionStatus().hasKey,false);
  assert.equal(fs.readFileSync(path.join(CFG.home,"coxdragon-codex-connection.json"),"utf8").includes(credential),false);
});

test("Codex：四种权限传给引擎，运行中禁止改变权限", async () => {
  reset(); const calls=[];
  cx.S.rpc.request=async(method,params)=>{calls.push({method,params});return method==="turn/start"?{turn:{id:"permission-turn",status:"completed"}}:{thread:{id:"permission-thread",cwd:CFG.workspace,turns:[]}};};
  for(const [mode,sandbox,approval,reviewer] of [["read","read-only","never","user"],["ask","danger-full-access","untrusted","user"],["auto","danger-full-access","untrusted","auto_review"],["full","danger-full-access","never","user"]]){
    cx.updatePermissions(mode);
    assert.equal(cx.status().permissions.mode,mode);
    await cx.startThread(CFG.workspace); const created=calls.at(-1).params;
    assert.equal(created.sandbox,sandbox);assert.equal(created.approvalPolicy,approval);assert.equal(created.approvalsReviewer,reviewer);
    await cx.startTurn("permission check","permission-thread"); const turn=calls.at(-1).params;
    assert.equal(turn.approvalPolicy,approval);assert.equal(turn.approvalsReviewer,reviewer);
    assert.equal(turn.sandboxPolicy.type,mode==="read"?"readOnly":"dangerFullAccess");
  }
  cx.S.runningTurns.set("b",{id:"busy",status:"inProgress"});
  assert.throws(()=>cx.updatePermissions("full"),/任务结束/);
  assert.throws(()=>cx.updatePermissions("invalid"),/无效/);
  cx.S.runningTurns.clear();cx.updatePermissions("ask");
});

test("Codex：自定义上下文上限保存、重启生效并拒绝无效或运行中修改", () => {
  reset();const baseUrl="https://context-override.test/v1";
  try{
    cx.setConnection({mode:"custom",baseUrl,model:"context-fixture",noKey:true});cx.S.rpc={stderr:""};
    cx.updateSettings({model:"context-fixture",effort:"",contextWindow:48000});
    assert.equal(connectionStatus().contextWindow,48000);assert.equal(cx.status().contextWindow,48000);assert.equal(cx.S.rpc,null);
    assert(connectionLaunch().args.includes("model_context_window=48000"));
    assert.throws(()=>cx.updateSettings({contextWindow:10}),/上下文/);
    cx.S.runningTurns.set("a",{id:"busy",status:"inProgress"});assert.throws(()=>cx.updateSettings({contextWindow:64000}),/任务结束/);
    assert.equal(connectionStatus().contextWindow,48000);
  }finally{cx.stopServer();cx.setConnection({mode:"chatgpt"});}
});

test("Codex：会话指标记录请求时模型强度、真实用量和首个输出至完成的时间", () => {
  reset();cx.S.model="fixture-model";cx.S.effort="high";
  const usage={last:{totalTokens:900,inputTokens:800,outputTokens:100,cachedInputTokens:600},total:{totalTokens:900,inputTokens:800,outputTokens:100,cachedInputTokens:600},modelContextWindow:64000};
  cx.handleNotify({method:"turn/started",params:{threadId:"b",turn:{id:"metric-turn",status:"inProgress"}}});
  cx.S.model="next-model";cx.S.effort="low";
  cx.handleNotify({method:"item/agentMessage/delta",params:{threadId:"b",turnId:"metric-turn",delta:"hello"}});
  cx.handleNotify({method:"thread/tokenUsage/updated",params:{threadId:"b",turnId:"metric-turn",tokenUsage:usage}});
  cx.handleNotify({method:"turn/completed",params:{threadId:"b",turn:{id:"metric-turn",status:"completed"}}});
  const metric=cx.status().metrics["metric-turn"];
  assert.equal(metric.model,"fixture-model");assert.equal(metric.effort,"high");assert.equal(metric.outputTokens,100);
  assert.equal(metric.total.cachedInputTokens,600);assert(metric.firstOutputAt>=metric.startedAt);assert(metric.completedAt>=metric.firstOutputAt);
  const saved=JSON.parse(fs.readFileSync(path.join(CFG.home,"coxdragon-codex-metrics.json")));
  assert.equal(saved["metric-turn"].total.inputTokens,800);
});

test("Codex：显式引用只接受已启用的技能、已安装插件和可访问文件", async () => {
  reset();cx.S.rpc.request=async method=>method==="skills/list"?{data:[{skills:[{name:"review",path:"/fixture/SKILL.md",enabled:true}]}]}:method==="plugin/list"?{marketplaces:[{plugins:[{id:"review@local",name:"review",installed:true,enabled:true,source:{type:"local",path:"/fixture/plugin"}}]}]}:{data:[]};
  const filename=path.join(CFG.workspace,"reference.txt");fs.writeFileSync(filename,"fixture");
  const input=await cx.referenceInput([{type:"skill",path:"/fixture/SKILL.md"},{type:"plugin",path:"review@local"},{type:"file",path:filename}],CFG.workspace);
  assert.deepEqual(input[0],{type:"skill",name:"review",path:"/fixture/SKILL.md"});
  assert.deepEqual(input[1],{type:"mention",name:"review",path:"plugin://review@local"});
  assert(input[2].text.includes("reference.txt"));
  await assert.rejects(cx.referenceInput([{type:"skill",path:"/missing/SKILL.md"}],CFG.workspace),/技能/);
  await assert.rejects(cx.referenceInput([{type:"file",path:path.join(CFG.home,"coxdragon-codex-connection.json")}],CFG.workspace),/文件无法引用/);
  await assert.rejects(cx.referenceInput(Array(21).fill({type:"file",path:filename}),CFG.workspace),/20/);
});

test("Codex：上下文按线程记录实际最近用量、上限与累计数，停止前落盘", () => {
  reset();
  const usage = { last: { totalTokens: 4500, inputTokens: 4000, outputTokens: 500 }, total: { totalTokens: 12000 }, modelContextWindow: 64000 };
  cx.handleNotify({ method: "thread/tokenUsage/updated", params: { threadId: "b", tokenUsage: usage } });
  cx.handleNotify({ method: "thread/tokenUsage/updated", params: { threadId: "a", tokenUsage: { ...usage, last: { totalTokens: 900 } } } });
  cx.handleNotify({ method: "thread/tokenUsage/updated", params: { threadId: "a", tokenUsage: { last: { totalTokens: -1 } } } });
  assert.equal(cx.status().contexts.b.last.totalTokens, 4500);
  assert.equal(cx.status().activeThread.context.last.totalTokens, 900);
  assert.equal(cx.status().contexts.b.modelContextWindow, 64000);
  assert.equal(cx.status().contexts.b.total.totalTokens, 12000);
  cx.stopServer();
  const disk = JSON.parse(fs.readFileSync(path.join(CFG.home, "coxdragon-codex-context.json")));
  assert.equal(disk.b.last.totalTokens, 4500); assert.equal(disk.a.last.totalTokens, 900);
});

test("Codex：压缩锁住目标线程，后台压缩不切换视图，生命周期完成后可发送", async () => {
  reset(); let acknowledge; const calls = [];
  cx.S.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/compact/start") return new Promise(resolve => { acknowledge = resolve; });
    return { turn: { id: "a-next", status: "inProgress" } };
  };
  const pending = cx.compactThread("b"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[0], { method: "thread/compact/start", params: { threadId: "b" } });
  assert.equal(cx.status().activeThread.id, "a"); assert.equal(codexActivity().busy, true);
  await assert.rejects(cx.compactThread("b"), /等待/);
  await assert.rejects(cx.startTurn("cannot race", "b"), /还在运行/);
  cx.handleNotify({ method: "item/started", params: { threadId: "b", item: { id: "compact", type: "contextCompaction" } } });
  cx.handleNotify({ method: "item/completed", params: { threadId: "b", item: { id: "compact", type: "contextCompaction" } } });
  acknowledge({}); await pending;
  assert.equal(cx.S.compacting.size, 0, "完成先于回执时不能复活压缩状态");
  await cx.startTurn("continue", "b");
});

test("Codex：压缩失败或引擎停止释放锁，旧失败不能清掉新引擎压缩", async () => {
  reset();
  cx.S.rpc.request = async () => { throw new Error("Synthetic compact failure"); };
  await assert.rejects(cx.compactThread("a"), /Synthetic compact failure/);
  assert.equal(cx.S.compacting.size, 0);
  let rejectOld; cx.S.rpc.request = () => new Promise((_, reject) => { rejectOld = reject; });
  const pending = cx.compactThread("b"); await new Promise(resolve => setImmediate(resolve));
  cx.stopServer(); cx.S.compacting.add("b"); rejectOld(new Error("Old engine gone"));
  await assert.rejects(pending, /Old engine gone/);
  assert.equal(cx.S.compacting.has("b"), true);
});

test("Codex：压缩回执先返回时仍保留后台服务，完成事件独立清除运行标记", async () => {
  reset(); cx.S.rpc.request = async () => ({});
  await cx.compactThread("b"); assert.equal(activityBusy(), true);
  cx.handleNotify({ method: "item/completed", params: { threadId: "b", item: { id: "compact", type: "contextCompaction" } } });
  assert.equal(activityBusy(), false); assert.equal(codexActivity().busy, false);
});

test("Codex：第三方模型强度保存和刷新一致，换模型重建空闲引擎并更新上下文覆盖", async () => {
  reset(); const baseUrl = "https://model-fixture.test/v1";
  rememberApiModels(baseUrl, [{ id: "first", contextWindow: 64000, supportedReasoningEfforts: ["low", "high"] }, { id: "second", contextWindow: 128000, supportedReasoningEfforts: ["max"] }]);
  try {
    cx.setConnection({ mode: "custom", baseUrl, model: "first", noKey: true });
    cx.S.rpc = { stderr: "", request: async () => ({ turn: { id: "selected-effort", status: "inProgress" } }) };
    cx.updateSettings({ model: "", effort: "high" });
    await cx.refreshModels(); assert.equal(cx.S.effort, "high"); assert.equal(cx.S.model, "first");
    assert(connectionLaunch().args.includes("model_context_window=64000"));
    cx.S.runningTurns.set("a", { id: "busy", status: "inProgress" });
    assert.throws(() => cx.updateSettings({ model: "second", effort: "max" }), /任务结束/);
    assert.equal(connectionStatus().model, "first"); cx.S.runningTurns.clear();
    cx.updateSettings({ model: "second", effort: "max" });
    assert.equal(cx.S.rpc, null); assert.equal(cx.S.model, "second");
    assert(connectionLaunch().args.includes("model_context_window=128000"));
    assert.equal(cx.S.models.find(m => m.isDefault).id, "second");
    let params; cx.S.rpc = { stderr: "", request: async (method, body) => { params = body; return { turn: { id: "next", status: "inProgress" } }; } };
    cx.S.loadedThreads.add("a"); await cx.startTurn("next", "a"); assert.equal(params.effort, "max"); assert.equal(params.model, "second");
  } finally { cx.stopServer(); cx.setConnection({ mode: "chatgpt" }); }
});

test("Codex：失败记录落盘保留协议和错误、重试、结束状态，不包含消息或密钥", () => {
  reset();
  const key = "fixture-private-key", prompt = "private-user-prompt";
  try {
    cx.setConnection({ mode: "custom", baseUrl: "https://provider.test/v1", model: "fixture", apiKey: key, wireApi: "responses" });
    cx.S.rpc = { stderr: "" }; cx.S.diagnostics.length = 0;
    cx.handleNotify({ method: "turn/started", params: { threadId: "a", turn: { id: "diagnostic-turn", status: "inProgress" }, input: prompt } });
    cx.handleNotify({ method: "error", params: { threadId: "a", turnId: "diagnostic-turn", error: { message: "upstream failed " + key }, willRetry: true } });
    cx.handleNotify({ method: "turn/completed", params: { threadId: "a", turn: { id: "diagnostic-turn", status: "failed", error: { message: "upstream failed " + key } } } });
    const text = fs.readFileSync(path.join(CFG.home, ".cache", "coxdragon", "codex-diagnostics.json"), "utf8"), report = JSON.parse(text);
    assert.equal(text.includes(key), false); assert.equal(text.includes(prompt), false);
    assert.equal(report.connection.wireApi, "responses"); assert.equal(report.events[1].willRetry, true);
    assert.equal(report.events[2].status, "failed"); assert.deepEqual(report.running, []);
  } finally { cx.stopServer(); cx.setConnection({ mode: "chatgpt" }); }
});

test("Codex：网络中断保留下载分片，下次请求从已有字节继续", async () => {
  const dest = path.join(CFG.home, "resume-test.tar.gz"), partial = dest + ".part";
  const originalFetch = globalThis.fetch;
  fs.writeFileSync(partial, "retained partial download");
  try {
    const offsets = [];
    globalThis.fetch = async (_url, opts) => { offsets.push(opts.headers.range); throw new Error("synthetic network interruption"); };
    await assert.rejects(cx.downloadTo("https://download.test/engine", dest), /network interruption/);
    await assert.rejects(cx.downloadTo("https://mirror.test/engine", dest), /network interruption/);
    assert.deepEqual(offsets, ["bytes=25-", "bytes=25-"]);
    assert.equal(fs.readFileSync(partial, "utf8"), "retained partial download");
    assert.equal(fs.existsSync(dest), false);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(partial, { force: true }); }
});

test("Codex：拒绝错误续传范围，不能把无关数据追加到分片", async () => {
  const dest = path.join(CFG.home, "invalid-range-test.tar.gz"), partial = dest + ".part";
  const originalFetch = globalThis.fetch;
  fs.writeFileSync(partial, "partial");
  try {
    globalThis.fetch = async () => new Response("wrong data", { status: 206, headers: { "content-range": "bytes 0-9/88007340" } });
    await assert.rejects(cx.downloadTo("https://download.test/engine", dest), /续传范围不匹配/);
    assert.equal(fs.readFileSync(partial, "utf8"), "partial");
    assert.equal(fs.existsSync(dest), false);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(partial, { force: true }); }
});

test("Codex：状态快照保留后台任务和等待中的审批，已解决的审批不再重放", () => {
  reset();
  cx.handleNotify({ method: "turn/started", params: { threadId: "b", turn: { id: "b1", status: "inProgress" } } });
  cx.handleRequest({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "b", command: "npm test" } });
  const snapshot = cx.status();
  assert.equal(snapshot.activeTurn, null, "后台任务不能占用当前线程的停止按钮");
  assert.deepEqual(snapshot.runningTurns, [{ threadId: "b", turn: { id: "b1", status: "inProgress" } }]);
  assert.equal(snapshot.approvals[0].id, "7");
  assert.equal(snapshot.approvals[0].params.command, "npm test");
  cx.handleNotify({ method: "serverRequest/resolved", params: { requestId: 7 } });
  assert.deepEqual(cx.status().approvals, []);
});

test("Codex：发送和停止显式指定线程，不受当前打开的线程影响", async () => {
  reset(); const calls = [];
  cx.S.rpc.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: "b1", status: "inProgress" } }; };
  await cx.startTurn("check b", "b");
  await cx.interruptTurn("b");
  assert.equal(calls[0].params.threadId, "b");
  assert.deepEqual(calls[1], { method: "turn/interrupt", params: { threadId: "b", turnId: "b1" } });
  assert.equal(cx.S.activeThread.id, "a");
  assert.equal(cx.S.activeTurn, null);
});

test("Codex：同一线程不能重复提交，另一线程可以启动", async () => {
  reset(); let finish;
  cx.S.rpc.request = (_, params) => params.threadId === "a"
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ turn: { id: "b1", status: "inProgress" } });
  const first = cx.startTurn("first", "a");
  await new Promise((r) => setImmediate(r));
  await assert.rejects(cx.startTurn("duplicate", "a"), /还在运行/);
  await cx.startTurn("parallel", "b");
  finish({ turn: { id: "a1", status: "inProgress" } }); await first;
  assert.equal(cx.S.runningTurns.size, 2);
});

test("Codex：完成事件先于启动回执时不复活任务，旧完成事件不结束新轮次", async () => {
  reset();
  cx.S.rpc.request = async () => {
    cx.handleNotify({ method: "turn/completed", params: { threadId: "a", turn: { id: "a1", status: "completed" } } });
    return { turn: { id: "a1", status: "inProgress" } };
  };
  const r = await cx.startTurn("quick", "a");
  assert.equal(r.turn.status, "completed");
  assert.equal(cx.S.runningTurns.has("a"), false);
  cx.handleNotify({ method: "turn/started", params: { threadId: "a", turn: { id: "a2", status: "inProgress" } } });
  cx.handleNotify({ method: "turn/completed", params: { threadId: "a", turn: { id: "a1", status: "completed" } } });
  assert.equal(cx.S.runningTurns.get("a").id, "a2");
});

test("Codex：恢复后台线程保留执行状态，停止引擎清理所有失效审批", async () => {
  reset();
  cx.S.runningTurns.set("b", { id: "b1", status: "inProgress" });
  cx.S.rpc.request = async () => ({ thread: { id: "b", turns: [] } });
  await cx.resumeThread("b");
  assert.equal(cx.S.activeTurn.id, "b1");
  cx.handleRequest({ id: 4, method: "item/fileChange/requestApproval", params: { threadId: "b" } });
  cx.stopServer();
  assert.equal(cx.S.approvals.size, 0); assert.equal(cx.S.runningTurns.size, 0);
});

test("Codex：进程已创建但还在初始化时，新请求等待初始化完成", async () => {
  reset(); let ready, called = false;
  cx.S.rpc.request = async () => { called = true; return { turn: { id: "a1", status: "inProgress" } }; };
  cx.S.starting = new Promise((resolve) => { ready = resolve; });
  const turn = cx.startTurn("wait for initialize", "a");
  await new Promise((r) => setImmediate(r));
  assert.equal(called, false);
  assert.equal(codexActivity().busy, true, "初始化等待期间也要保留后台服务");
  ready(cx.S.rpc); await turn; cx.S.starting = null;
  assert.equal(called, true);
});

test("Codex：停止后的延迟回执不能复活旧任务或清掉新任务的后台标记", async () => {
  reset(); let oldFinish, newFinish;
  cx.S.rpc.request = () => new Promise((resolve) => { oldFinish = resolve; });
  const oldTurn = cx.startTurn("old", "b");
  await new Promise((r) => setImmediate(r)); cx.stopServer();
  cx.S.loadedThreads.add("b");
  cx.S.rpc = { stderr: "", request: () => new Promise((resolve) => { newFinish = resolve; }) };
  const newTurn = cx.startTurn("new", "b"); await new Promise((r) => setImmediate(r));
  oldFinish({ turn: { id: "old", status: "inProgress" } });
  await assert.rejects(oldTurn, /已停止/);
  assert.equal(cx.S.runningTurns.size, 0); assert.equal(cx.S.startingTurns.has("b"), true); assert.equal(activityBusy(), true);
  newFinish({ turn: { id: "new", status: "inProgress" } }); await newTurn;
  assert.equal(cx.S.runningTurns.get("b").id, "new");
});

test("Codex：显式失效目录拒绝创建任务，不切换到默认工作区", async () => {
  reset(); let called = false;
  cx.S.rpc.request = async () => { called = true; };
  for (const cwd of [path.join(CFG.workspace, "missing-project"), "relative-project", " \t"]) {
    await assert.rejects(cx.startThread(cwd), (e) => e.statusCode === 400);
  }
  assert.equal(called, false);
  assert.equal(cx.S.activeThread.id, "a");
});

test("Codex：新代引擎先恢复目标线程，后台发送不改变当前视图", async () => {
  reset(); cx.stopServer();
  const calls = [];
  cx.S.rpc = { stderr: "", request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") cx.handleNotify({ method: "thread/started", params: { thread: { id: params.threadId, cwd: CFG.workspace } } });
    return method === "thread/resume" ? { thread: { id: params.threadId, cwd: CFG.workspace, turns: [] } }
      : { turn: { id: "restarted-turn", status: "inProgress" } };
  } };
  await cx.startTurn("continue after restart", "b");
  assert.deepEqual(calls.map((c) => c.method), ["thread/resume", "turn/start"]);
  assert.equal(cx.S.activeThread.id, "a");
  assert.equal(cx.S.loadedThreads.has("b"), true);
  cx.handleNotify({ method: "turn/completed", params: { threadId: "b", turn: { id: "restarted-turn", status: "completed" } } });
  await cx.startTurn("next", "b");
  assert.equal(calls.filter((c) => c.method === "thread/resume").length, 1);
});

test("Codex：创建和恢复在途时阻止切连接，停止后的旧回执不复活线程", async () => {
  for (const kind of ["start", "resume"]) {
    reset(); let finish;
    cx.S.rpc.request = () => new Promise((resolve) => { finish = resolve; });
    const pending = kind === "start" ? cx.startThread(CFG.workspace) : cx.resumeThread("b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(codexActivity().busy, true);
    assert.equal(activityBusy(), true);
    assert.throws(() => cx.setConnection({ mode: "chatgpt" }), (e) => e.statusCode === 409);
    cx.stopServer();
    finish({ thread: { id: "late-thread", cwd: CFG.workspace, turns: [] } });
    await assert.rejects(pending, /已停止/);
    assert.equal(cx.S.activeThread.id, "a");
    assert.equal(cx.S.loadedThreads.size, 0);
    assert.equal(codexActivity().busy, false);
  }
});

test("Codex：待回执、运行和审批期间保留后台标记，旧引擎空闲不能清掉它", async () => {
  reset(); let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  cx.S.rpc.request = () => pending;
  const turn = cx.startTurn("background", "b");
  await new Promise((r) => setImmediate(r));
  const marker = path.join(CFG.home, ".run-active");
  assert.equal(codexActivity().starting, 1); assert.equal(fs.readFileSync(marker, "utf8"), String(process.pid));
  runFlag(false); assert.equal(fs.existsSync(marker), true);
  finish({ turn: { id: "b1", status: "inProgress" } }); await turn;
  cx.handleRequest({ id: 19, method: "item/commandExecution/requestApproval", params: { threadId: "b", turnId: "b1", command: "npm test" } });
  assert.equal(codexActivity().approvals[0].id, "codex:19");
  assert.equal(codexActivity().approvals[0].sessionId, "b");
  runFlag(true); cx.stopServer();
  assert.equal(activityBusy(), true, "停止 Codex 仍保留旧引擎的忙碌标记");
  runFlag(false); assert.equal(fs.existsSync(marker), false);
});

test("Codex：后台完成事件包含正确任务、失败状态，完成后清理该轮审批", () => {
  reset(); const events = [], unsub = onCodexActivity((e) => events.push(e));
  try {
    cx.handleNotify({ method: "turn/started", params: { threadId: "b", turn: { id: "b2", status: "inProgress" } } });
    cx.handleRequest({ id: 20, method: "item/fileChange/requestApproval", params: { threadId: "b", turnId: "b2" } });
    cx.handleNotify({ method: "turn/completed", params: { threadId: "b", turn: { id: "b2", status: "failed", error: { message: "test failure" } } } });
    assert.equal(codexActivity().busy, false); assert.equal(codexActivity().approvals.length, 0);
    const done = events.find((e) => e.type === "codex_done");
    assert.equal(done.sessionId, "b"); assert.equal(done.engine, "codex"); assert.equal(done.failed, true);
    assert.equal(done.runId, "codex:b2");
  } finally { unsub(); }
});

test("Codex：请求失败释放后台标记；持久设置只接受模型支持的思考强度", async () => {
  reset(); cx.S.rpc.request = async () => { throw new Error("synthetic RPC failure"); };
  await assert.rejects(cx.startTurn("failure", "b"), /synthetic RPC failure/);
  assert.equal(codexActivity().busy, false); assert.equal(activityBusy(), false);
  cx.S.models = [{ id: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }];
  assert.deepEqual(cx.updateSettings({ model: "test-model", effort: "high" }), { model: "test-model", effort: "high", contextWindow: 0 });
  const savedPrefs=JSON.parse(fs.readFileSync(path.join(CFG.home, "coxdragon-codex.json"), "utf8"));
  assert.equal(savedPrefs.model,"test-model");assert.equal(savedPrefs.effort,"high");assert.equal(savedPrefs.contextWindow,0);
  assert.throws(() => cx.updateSettings({ model: "test-model", effort: "low" }), /不支持/);
  assert.throws(() => cx.updateSettings({ model: "missing" }), /不支持/);
  assert.equal(cx.S.effort, "high");
  const pref = path.join(CFG.home, "coxdragon-codex.json");
  fs.rmSync(pref); fs.mkdirSync(pref);
  assert.throws(() => cx.updateSettings({ model: "", effort: "" }), /没有保存/);
  assert.equal(cx.S.model, "test-model", "写盘失败不能假装保存成功");
  fs.rmdirSync(pref);
});

test("Codex：扩展只用 Codex 协议；MCP 失败不隐藏技能，拒绝修改未发现的技能", async () => {
  reset(); const calls = [];
  cx.S.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "mcpServerStatus/list") throw new Error("MCP unavailable");
    if (method === "skills/list") return { data: [{ cwd: CFG.workspace, skills: [{ name: "test-skill", path: "/synthetic/SKILL.md", enabled: true }], errors: [] }] };
    return { ok: true };
  };
  const inventory = await cx.extensions(CFG.workspace);
  assert.equal(inventory.skills[0].skills[0].name, "test-skill"); assert.equal(inventory.mcpError, "MCP unavailable");
  await assert.rejects(cx.setSkill(CFG.workspace, "/unlisted/SKILL.md", false), /不在/);
  assert.equal(calls.some((c) => c.method === "skills/config/write"), false);
  await cx.setSkill(CFG.workspace, "/synthetic/SKILL.md", false);
  assert.deepEqual(calls.at(-1), { method: "skills/config/write", params: { path: "/synthetic/SKILL.md", enabled: false } });
});

test("Codex：共享事件总线和网关忙碌状态包含 Codex，重连快照保留审批", async () => {
  reset();
  const [{ routeBus, onPublish, publish }, { routeCaps }] = await Promise.all([import("../gw/bus.mjs"), import("../gw/caps.mjs")]);
  const events = [], unsub = onPublish((ev) => events.push(ev));
  const response = () => ({ writeHead() {}, end(body) { this.body = JSON.parse(body); } });
  try {
    cx.handleNotify({ method: "turn/started", params: { threadId: "b", turn: { id: "bus-turn", status: "inProgress" } } });
    cx.handleRequest({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "b", turnId: "bus-turn", command: "npm test" } });
    assert.equal(events.at(-1).type, "codex_state");
    publish({ type: "state", runs: [] }); assert.equal(events.at(-1).codex.approvals[0].id, "codex:77");
    const res = response(); await routeBus({ method: "GET" }, res, new URL("http://localhost/api/state"), "/api/state");
    assert.equal(res.body.codex.approvals[0].sessionId, "b");
    const status = response(); await routeCaps({ method: "GET" }, status, new URL("http://localhost/api/status"), "/api/status");
    assert.equal(status.body.busy, true); assert.equal(status.body.running, 1);
    assert.equal(status.body.nativeApp, !!PREFIX); assert.equal(status.body.product, PREFIX ? "coxdragon" : "Claude CLI");
    cx.stopServer(); assert.equal(events.at(-1).codex.busy, false);
  } finally { unsub(); }
});

test("Codex：等待启动回执时拒绝网关重启，拒绝前不写执行方式偏好", async (t) => {
  reset();
  const { routeSettings } = await import("../gw/settings.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  cx.S.rpc.request = () => new Promise((resolve) => { finish = resolve; });
  const turn = cx.startTurn("pending restart guard", "b");
  await new Promise((r) => setImmediate(r));
  const pref = path.join(CFG.runtime, ".exec-mode");
  const before = fs.existsSync(pref) ? fs.readFileSync(pref, "utf8") : null;
  try {
    const req = Readable.from([Buffer.from(JSON.stringify({ mode: "loader", restart: true }))]); req.method = "POST";
    const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    await routeSettings(req, res, new URL("http://localhost/api/exec-mode"), "/api/exec-mode");
    assert.equal(res.code, 409); assert.match(res.body.error, /任务/);
    assert.equal(fs.existsSync(pref) ? fs.readFileSync(pref, "utf8") : null, before);
  } finally {
    finish({ turn: { id: "restart-guard", status: "inProgress" } }); await turn; cx.stopServer();
  }
});

test("Codex：运行和等待审批时推迟自动清理，全部结束后恢复", async () => {
  reset();
  const { autoCleanTick } = await import("../gw/storage.mjs");
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  const previous = SETTINGS.autoClean;
  const file = path.join(CFG.home, ".npm", "_cacache", "idle-guard-fixture");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "old cache");
  const old = new Date(Date.now() - 10 * 86400e3); fs.utimesSync(file, old, old);
  SETTINGS.autoClean = { enabled: true, every: "day" };
  try {
    cx.handleNotify({ method: "turn/started", params: { threadId: "b", turn: { id: "cleanup-guard", status: "inProgress" } } });
    assert.equal(await autoCleanTick(), null); assert.equal(fs.existsSync(file), true);
    cx.stopServer();
    cx.handleRequest({ id: 89, method: "item/commandExecution/requestApproval", params: { threadId: "b", command: "npm test" } });
    assert.equal(await autoCleanTick(), null); assert.equal(fs.existsSync(file), true);
    cx.stopServer();
    const result = await autoCleanTick();
    assert.equal(result.auto, true); assert.ok(result.n + result.skipped > 0, "空闲后才开始处理缓存候选项");
  } finally { SETTINGS.autoClean = previous; cx.stopServer(); fs.rmSync(file, { force: true }); }
});

test("Codex：自定义 API 的地址校验、私有密钥保存与进程配置", async () => {
  reset();
  const key = "synthetic-private-key-never-a-real-credential";
  const file = path.join(CFG.home, "coxdragon-codex-connection.json");
  try {
    for (const baseUrl of ["file:///secret", "https://user:pass@example.test/v1", "https://example.test/v1?key=x"]) {
      assert.throws(() => cx.setConnection({ mode: "custom", baseUrl, model: "my-model", apiKey: key }), (e) => e.statusCode === 400);
    }
    const saved = cx.setConnection({ mode: "custom", baseUrl: "https://example.test/v1/responses", model: "my-model", apiKey: key });
    assert.equal(saved.connection.baseUrl, "https://example.test/v1"); assert.equal(saved.connection.hasKey, true);
    assert.equal(JSON.stringify(saved).includes(key), false);
    const launch = connectionLaunch();
    assert.equal(launch.args.join(" ").includes(key), false); assert.equal(launch.env.COXDRAGON_CUSTOM_API_KEY, key);
    assert.ok(launch.args.includes('model_providers.coxdragon_custom.wire_api="responses"'));
    assert.ok(launch.args.includes('model_providers.coxdragon_custom.requires_openai_auth=false'));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).apiKey, key);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => cx.setConnection({ mode: "custom", baseUrl: "https://different.test/v1", model: "my-model", apiKey: "" }), /API Key/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "换地址时不能自动把旧密钥送过去");
    cx.setConnection({ mode: "custom", baseUrl: "https://example.test/v1", model: "my-model", apiKey: "" });
    assert.equal(connectionLaunch().env.COXDRAGON_CUSTOM_API_KEY, key, "同地址留空可保留密钥");
    cx.setConnection({ mode: "custom", baseUrl: "http://127.0.0.1:9000/v1", model: "local-model", noKey: true });
    assert.deepEqual(connectionLaunch().env, {}); assert.equal(connectionStatus().hasKey, false);
  } finally { cx.stopServer(); cx.setConnection({ mode: "chatgpt" }); }
});

test("Codex：运行时拒绝切换 API，保存失败保持原连接与账号", () => {
  reset();
  const file = path.join(CFG.home, "coxdragon-codex-connection.json");
  const original = fs.readFileSync(file);
  const before = connectionStatus();
  cx.handleRequest({ id: 901, method: "item/commandExecution/requestApproval", params: { threadId: "b", command: "test" } });
  assert.throws(() => cx.setConnection({ mode: "custom", baseUrl: "https://blocked.test/v1", model: "blocked", apiKey: "fake" }), (e) => e.statusCode === 409);
  assert.deepEqual(fs.readFileSync(file), original);
  cx.stopServer(); cx.S.account = { account: { type: "chatgpt", email: "still@example.test" } };
  fs.rmSync(file); fs.mkdirSync(file);
  try {
    assert.throws(() => cx.setConnection({ mode: "custom", baseUrl: "https://not-saved.test/v1", model: "x", apiKey: "fake" }), /没有保存/);
    assert.deepEqual(connectionStatus(), before); assert.equal(cx.S.account.account.email, "still@example.test");
  } finally { fs.rmdirSync(file); fs.writeFileSync(file, original); }
});

test("Codex：自定义模型和供应商贯穿新建、恢复、发送；切回 ChatGPT 不携带第三方密钥", async () => {
  reset();
  const calls = [];
  try {
    cx.setConnection({ mode: "custom", baseUrl: "https://provider.test/v1", model: "provider-model", apiKey: "fake-provider-key" });
    cx.S.rpc = { stderr: "", request: async (method, params) => {
      calls.push({ method, params });
      return method === "turn/start" ? { turn: { id: "provider-turn", status: "inProgress" } } : { thread: { id: "b", cwd: CFG.workspace, turns: [] } };
    } };
    const models = await cx.refreshModels(); assert.equal(models[0].id, "provider-model");
    assert.equal(calls.length, 0, "自定义模型不能被 OpenAI 账号目录替换");
    await cx.startThread(CFG.workspace); await cx.resumeThread("b"); await cx.startTurn("hello", "b");
    assert.equal(calls.find((c) => c.method === "thread/start").params.modelProvider, "coxdragon_custom");
    assert.equal(calls.find((c) => c.method === "thread/resume").params.modelProvider, "coxdragon_custom");
    assert.equal(calls.find((c) => c.method === "turn/start").params.model, "provider-model");
    cx.stopServer(); cx.setConnection({ mode: "chatgpt" });
    assert.deepEqual(connectionLaunch().env, {}); assert.equal(connectionLaunch().modelProvider, "openai");
  } finally { cx.stopServer(); cx.setConnection({ mode: "chatgpt" }); }
});
