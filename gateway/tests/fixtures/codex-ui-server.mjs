// 真实前端 + 内存协议替身：不导入网关，不启动引擎，不读账号或项目数据。
import { startManagedUiServer } from "./managed-ui-server.mjs";

export async function startCodexUiServer() {
  const clients = new Set(), now = Math.floor(Date.now() / 1000);
  const state = { requests: [], pending: [], running: [], active: null, seq: 0, turnDelay: 0,
    installed: true, server: true, account: { email: "developer@example.test", planType: "Plus" }, install: { state: "done" },
    installFailures: 0, loginDelay: 0, cancelFailure: false, authorizeOnRefresh: false,
    model: "", effort: "", settingsFailure: false, skillEnabled: true, extensionFailure: false, connectionFailure: false,
    apiDelay: 0, apiFailure: false, contexts: {}, compacting: [], compactFailure: false,
    schedules: [{ id: "legacy-task", name: "旧自动化", prompt: "整理项目", on: true, nextAt: Date.now() + 60000 }], scheduleRunning: ["legacy-task"], scheduleFailure: false,
    connection: { mode: "chatgpt", baseUrl: "", model: "", hasKey: false, noKey: false, configured: false, wireApi: "responses" },
    notify: { ok: true, done: true, ask: true, system: true, chDone: true, chAsk: true } };
  const projects = [{ id: "p1", name: "coxdragon", path: "/synthetic/coxdragon" }, { id: "p2", name: "website", path: "/synthetic/website" }];
  const threads = [
    { id: "a", name: "完善移动端工作台", cwd: projects[0].path, updatedAt: now, turns: [{ id: "a0", status: "completed", items: [
      { id: "u1", type: "userMessage", content: [{ type: "text", text: "把工作台做成适合手机和平板的开发环境。" }] },
      { id: "m1", type: "agentMessage", text: "已经梳理了项目结构。我会先完善项目导航和任务切换，再把改动审阅接到同一个工作目录。" },
      { id: "cmd1", type: "commandExecution", command: "node --check gateway/web/codex.js", status: "completed", exitCode: 0, aggregatedOutput: "Syntax check passed." },
      { id: "m2", type: "agentMessage", text: "第一版已接入项目分组、草稿恢复和改动面板。你可以在右侧逐行查看修改，随后打开项目终端验证。" },
    ] }] },
    { id: "b", name: "检查线程恢复与审批", cwd: projects[0].path, updatedAt: now - 900, turns: [] },
    { id: "c", name: "调整首页布局", cwd: projects[1].path, updatedAt: now - 3600, turns: [] },
  ];
  state.threads = threads;
  const snapshot = () => ({ installed: state.installed, server: state.server, version: "fixture", account: state.account,
    cwd: projects[0].path, activeThread: threads.find((th) => th.id === state.active) || null, approvals: state.pending,
    model: state.model, effort: state.effort, connection: { ...state.connection }, paths: { codexHome: "/synthetic/home/.codex" },
    contexts: state.contexts, compacting: state.compacting,
    runningTurns: state.running, models: state.connection.mode === "custom" ? [{ id: state.connection.model, displayName: state.connection.model, isDefault: true, supportedReasoningEfforts: [] }] :
      [{ id: "fixture-model", displayName: "Codex · Demo", isDefault: true, inputModalities: ["text", "image", "audio"], contextWindow: 128000, capabilitySources: { input: "codex", context: "models.dev" }, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
      { id: "fixture-fast", displayName: "Codex · Fast", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], install: state.install });
  const send = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const emit = (ev) => { for (const res of clients) if (!res.destroyed) send(res, ev); };
  const reply = (res, data, code = 200) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); return true; };
  const fixture = await startManagedUiServer({ handleRequest: async (req, res, url) => {
    const p = url.pathname;
    if (p === "/test-blank") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<!doctype html><title>Test isolation</title>"); return true; }
    if (p === "/api/notices") return reply(res, { items: [{ id: "legacy", title: "Legacy Claude notice", body: "Must not interrupt the Codex workspace" }] });
    if (p === "/api/state") return reply(res, { runs: [], run: null, queue: [], maxParallel: 3, interrupted: [] });
    if (p === "/api/app/upd_status") return reply(res, { ok: true, auto: true, channel: "stable", flavor: "28", flavorPref: "auto", sources: { app: "leemwood/coxdragon", devkit: "greyoak111/coxdragon", components: "greyoak111/coxdragon-components" }, items: [
      { id: "app", name: "coxdragon", current: "fixture", state: "uptodate" },
      { id: "devkit", name: "Devkit", current: "fixture", state: "uptodate" },
      { id: "claude", name: "Claude Code", current: "fixture", state: "uptodate" },
    ] });
    if (p === "/api/env-facts") return reply(res, { supported: false, fail: [] });
    if (!(p.startsWith("/api/codex/") || p.startsWith("/api/git/") || p.startsWith("/api/app/notify_") || p.startsWith("/api/sched") || p === "/api/projects" || p === "/api/files")) return false;
    let body = {};
    if (["POST", "PATCH"].includes(req.method)) { let s = ""; for await (const chunk of req) s += chunk; body = JSON.parse(s || "{}"); }
    state.requests.push({ path: p, method: req.method, body, query: Object.fromEntries(url.searchParams) });
    if (p === "/api/sched") return reply(res, { tasks: state.schedules, running: state.scheduleRunning });
    if (p.startsWith("/api/sched/")) {
      if (state.scheduleFailure) return reply(res, { error: "Synthetic schedule save failure" }, 500);
      const task = state.schedules.find(task => task.id === p.split("/")[3]);
      if (!task) return reply(res, { error: "Missing task" }, 404);
      if (req.method === "DELETE") {
        if (state.scheduleRunning.includes(task.id)) return reply(res, { error: "Task is running; stop it first" }, 409);
        state.schedules = state.schedules.filter(item => item !== task);
      } else if (p.endsWith("/stop")) { task.on = false; state.scheduleRunning = state.scheduleRunning.filter(id => id !== task.id); }
      else task.on = body.on;
      return reply(res, { ok: true, task });
    }
    if (p === "/api/codex/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); clients.add(res);
      res.on("close", () => clients.delete(res)); send(res, { type: "status", status: snapshot() }); return true;
    }
    if (p === "/api/codex/refresh" && state.authorizeOnRefresh) { state.account = { email: "new@example.test", planType: "Plus" }; emit({ type: "status", status: snapshot() }); }
    if (p === "/api/codex/status" || p === "/api/codex/refresh") return reply(res, snapshot());
    if (p === "/api/codex/install") {
      if (state.installFailures > 0) { state.installFailures--; return reply(res, { error: "Synthetic download interrupted" }, 503); }
      state.install = { state: "installing", phase: "Downloading", done: 20, total: 100 };
      emit({ type: "install", install: state.install }); return reply(res, { ok: true });
    }
    if (p === "/api/codex/login") {
      if (state.loginDelay) await new Promise((r) => setTimeout(r, state.loginDelay));
      return reply(res, { type: "chatgptDeviceCode", loginId: "synthetic-login", userCode: "ABCD-EFGH", verificationUrl: "https://auth.example.test/codex" });
    }
    if (p === "/api/codex/login-cancel") return reply(res, state.cancelFailure ? { error: "Synthetic cancellation failed" } : { ok: true }, state.cancelFailure ? 503 : 200);
    if (p === "/api/codex/logout") { state.account = null; return reply(res, { ok: true }); }
    if (p === "/api/codex/threads") return reply(res, { threads });
    if (p === "/api/files") return reply(res, { path: url.searchParams.get("path"), parent: "/synthetic", roots: [],
      entries: [{ name: "fixture.apk", kind: "archive", size: 128, dir: false }] });
    if (p === "/api/projects" && req.method === "GET") return reply(res, { projects });
    if (p === "/api/projects" && req.method === "POST") { const project = { id: "p" + projects.length, name: body.name, path: body.path }; projects.push(project); return reply(res, { ok: true, project }); }
    if (p === "/api/codex/open-thread") { state.active = body.threadId; return reply(res, { thread: threads.find((th) => th.id === body.threadId) }); }
    if (p === "/api/codex/thread") { const thread = { id: "new" + ++state.seq, name: "新任务", cwd: body.cwd, turns: [] }; threads.unshift(thread); state.active = thread.id; return reply(res, { thread }); }
    if (p === "/api/codex/turn") {
      const turn = { id: "turn" + ++state.seq, status: "inProgress" };
      state.running.push({ threadId: body.threadId, turn });
      emit({ type: "rpc", method: "turn/started", params: { threadId: body.threadId, turn } });
      if (state.turnDelay) await new Promise((r) => setTimeout(r, state.turnDelay));
      return reply(res, { turn });
    }
    if (p === "/api/codex/interrupt") {
      const turn = state.running.find((r) => r.threadId === body.threadId)?.turn;
      state.running = state.running.filter((r) => r.threadId !== body.threadId);
      if (turn) emit({ type: "rpc", method: "turn/completed", params: { threadId: body.threadId, turn: { ...turn, status: "interrupted" } } });
      return reply(res, { ok: true });
    }
    if (p === "/api/codex/approve") { state.pending = state.pending.filter((a) => String(a.id) !== body.id); emit({ type: "approval-done", id: body.id }); return reply(res, { ok: true }); }
    if (p === "/api/codex/compact") {
      if (state.compactFailure) return reply(res, { error: "Synthetic compaction failure" }, 503);
      state.compacting.push(body.threadId);
      emit({ type: "rpc", method: "item/started", params: { threadId: body.threadId, turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction" } } });
      return reply(res, { ok: true });
    }
    if (p === "/api/codex/settings") {
      if (state.settingsFailure) return reply(res, { error: "Synthetic storage full" }, 500);
      state.model = body.model; state.effort = body.effort; return reply(res, body);
    }
    if (p === "/api/codex/connection/models" || p === "/api/codex/connection/test") {
      if (state.apiDelay) await new Promise((r) => setTimeout(r, state.apiDelay));
      const url = body.baseUrl.replace(/\/+$/, "") + (p.endsWith("/models") ? "/models" : "/chat/completions");
      if (state.apiFailure) return reply(res, { ok: false, message: "返回的是网页，请使用服务商提供的 API 基础地址，通常包含 /v1", attempts: [{ ok: false, url, status: 404, code: "html", elapsedMs: 15 }] });
      return reply(res, p.endsWith("/models") ? { ok: true, baseUrl: body.baseUrl, models: ["fixture-chat-model", "fixture-reasoning-model"], modelDetails: [
        { id: "fixture-chat-model", inputModalities: ["text", "image"], contextWindow: 64000, supportedReasoningEfforts: [], capabilitySources: { input: "models.dev" } },
        { id: "fixture-reasoning-model", inputModalities: ["text"], contextWindow: 128000, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], capabilitySources: { effort: "provider" } },
      ] } :
        { ok: true, baseUrl: body.baseUrl, wireApi: body.wireApi === "auto" ? "chat" : body.wireApi, model: body.model, elapsedMs: 42, attempts: [{ ok: true, url, status: 200, elapsedMs: 42 }] });
    }
    if (p === "/api/codex/connection") {
      if (state.running.length) return reply(res, { error: "还有任务在运行，请结束后再切换连接" }, 409);
      if (state.connectionFailure) return reply(res, { error: "Synthetic connection storage full" }, 500);
      state.connection = { mode: body.mode, baseUrl: body.baseUrl || state.connection.baseUrl,
        model: body.model || state.connection.model, hasKey: body.noKey ? false : !!body.apiKey || state.connection.hasKey,
        noKey: !!body.noKey, configured: body.mode === "custom", wireApi: body.wireApi || state.connection.wireApi || "responses" };
      state.model = body.mode === "custom" ? body.model : ""; state.effort = ""; state.account = null; state.active = null;
      return reply(res, snapshot());
    }
    if (p === "/api/codex/extensions") return reply(res, state.extensionFailure ? { error: "Synthetic extension failure" } : {
      cwd: url.searchParams.get("cwd"), codexHome: "/synthetic/home/.codex", configPath: "/synthetic/home/.codex/config.toml", agentsPath: url.searchParams.get("cwd") + "/AGENTS.md",
      skills: [{ cwd: url.searchParams.get("cwd"), skills: [{ name: "project-review", path: "/synthetic/home/.agents/skills/review/SKILL.md", description: "Review project changes", enabled: state.skillEnabled }], errors: [] }],
      mcp: [{ name: "project-tools", authStatus: "notLoggedIn", tools: { review: {} } }],
    }, state.extensionFailure ? 500 : 200);
    if (p === "/api/codex/skill") { state.skillEnabled = body.enabled; return reply(res, { ok: true }); }
    if (p === "/api/app/notify_status") return reply(res, state.notify);
    if (p === "/api/app/notify_set") { Object.assign(state.notify, body); return reply(res, { ok: true }); }
    if (p === "/api/app/notify_settings") return reply(res, { ok: true });
    if (p === "/api/git/status") return reply(res, { root: url.searchParams.get("dir"), branch: "codex/desktop-workflow", files: [{ path: "gateway/web/codex.js", kind: "modified", add: 142, del: 36 }, { path: "gateway/web/codex.css", kind: "modified", add: 85, del: 18 }] });
    if (p === "/api/git/diff") return reply(res, { diff: "diff --git a/codex.js b/codex.js\n--- a/codex.js\n+++ b/codex.js\n@@ -42,3 +42,6 @@\n function openThread(id) {\n-  loadThread(id);\n+  saveDraft();\n+  await loadThread(id);\n+  restoreDraft();\n }" });
    return reply(res, { error: "Unknown fixture route" }, 404);
  } });
  Object.assign(fixture.state.status, { product: "coxdragon", nativeApp: true });
  return { ...fixture, codex: state, emit, snapshot, close: async () => { for (const res of clients) res.destroy(); await fixture.close(); } };
}
