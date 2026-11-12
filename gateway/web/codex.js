// ─────────────────────────────────────────────────────────────────────
//  Codex 工作台前端
//
//  只挂在 #tab-codex 上；复用 app.js 的 __cc.api / renderMd / esc / toast，
//  不碰主对话的 DOM。引擎在网关的 gw/codex.mjs，本文件只做三件事：
//    · 把状态（安装 / 登录 / 模型 / 线程 / 轮次）画出来
//    · 把 app-server 的 item 事件铺成消息、工具卡和审批卡
//    · 把用户的点击变成 /api/codex/* 的 POST
// ─────────────────────────────────────────────────────────────────────
(() => {
  "use strict";
  const root = document.getElementById("tab-codex");
  if (!root) return;
  const CC = window.__cc || {};
  const $ = (id) => document.getElementById(id);
  const A = (k, fallback) => (typeof CC[k] === "function" ? CC[k] : fallback);
  const esc = A("esc", (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const md = A("renderMd", (s) => esc(s).replace(/\n/g, "<br>"));
  const toast = A("toast", (m, e) => console.log(e ? "✗" : "•", m));
  const api = A("api", async (p, o) => {
    const r = await fetch(p, o);
    if (!r.ok) { let m = "HTTP " + r.status; try { const j = await r.json(); m = j.error || j.message || m; } catch {} throw new Error(m); }
    return r.json();
  });
  const copyText = A("copyText", (t) => { try { navigator.clipboard.writeText(t); return true; } catch { return false; } });
  const fmtSize = A("fmtSize", (n) => (n ? Math.round(n / 1048576) + " MB" : ""));
  const relTime = A("relTime", (ms) => (ms ? new Date(ms * 1000).toLocaleString() : ""));

  const LS = {
    get: (k, d) => { try { return localStorage.getItem("cx." + k) || d; } catch { return d; } },
    set: (k, v) => { try { v ? localStorage.setItem("cx." + k, v) : localStorage.removeItem("cx." + k); } catch {} },
  };
  const st = {
    status: null, es: null, open: false,
    thread: null, threadId: LS.get("thread", ""),
    items: new Map(), approvals: new Map(),
    login: null, model: LS.get("model", ""), effort: LS.get("effort", ""), cwd: LS.get("cwd", ""),
    busy: false, bootRaf: 0, lastWarn: "",
  };

  // ── DOM ─────────────────────────────────────────────────────────────
  let dom = null;
  function ensureDom() {
    if (dom) return dom;
    root.innerHTML = `
<div class="cx">
  <aside class="cx-side">
    <div class="cx-side-top">
      <div class="cx-logo">coxdragon<small>Codex 工作台</small></div>
      <button class="cx-new" data-act="new" title="新任务" aria-label="新任务">+</button>
    </div>
    <div class="cx-acct" id="cx-acct"></div>
    <div class="cx-side-label">任务</div>
    <div class="cx-threads" id="cx-threads"></div>
  </aside>
  <main class="cx-main">
    <header class="cx-head" id="cx-head"></header>
    <div class="cx-log" id="cx-log"><div id="cx-boot"></div><div id="cx-msgs"></div></div>
    <div class="cx-dock">
      <div class="cx-approvals" id="cx-approvals"></div>
      <div class="cx-row">
        <textarea id="cx-input" rows="1" placeholder="交给 Codex 一件事…" autocomplete="off" spellcheck="false"></textarea>
        <button class="cx-send" data-act="send" id="cx-send">发送</button>
        <button class="cx-stop hidden" data-act="stop" id="cx-stop">停止</button>
      </div>
      <div class="cx-foot">
        <span id="cx-state"><i class="cx-dot idle"></i>未连接</span>
        <span id="cx-cwd"></span>
      </div>
    </div>
  </main>
</div>`;
    dom = {
      acct: $("cx-acct"), threads: $("cx-threads"), head: $("cx-head"),
      log: $("cx-log"), boot: $("cx-boot"), msgs: $("cx-msgs"),
      apprs: $("cx-approvals"), input: $("cx-input"), send: $("cx-send"), stop: $("cx-stop"),
      state: $("cx-state"), cwd: $("cx-cwd"),
    };
    root.addEventListener("click", onClick);
    dom.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    dom.input.addEventListener("input", () => { dom.input.style.height = "auto"; dom.input.style.height = Math.min(180, dom.input.scrollHeight) + "px"; });
    dom.log.addEventListener("click", (e) => {
      const b = e.target.closest(".copy-btn");
      if (b) { const pre = b.parentElement && b.parentElement.querySelector("code"); if (pre) { copyText(pre.textContent || ""); toast("已复制"); } }
    });
    return dom;
  }

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "new") return newThread();
    if (act === "send") return send();
    if (act === "stop") return interrupt();
    if (act === "install") return install();
    if (act === "login") return login();
    if (act === "logout") return logout();
    if (act === "login-open") return openLoginUrl();
    if (act === "login-copy") { if (st.login) { copyText(st.login.userCode || ""); toast("登录码已复制"); } return; }
    if (act === "login-cancel") return cancelLogin();
    if (act === "open-thread") return openThread(el.dataset.id);
    if (act === "approve") return approve(el.dataset.id, el.dataset.decision, el.closest(".cx-appr"));
    if (act === "approve-input") return approveInput(el.dataset.id, el.closest(".cx-appr"));
    if (act === "refresh") return refresh();
    if (act === "retry") return refresh();
  }

  // ── 状态 / 绘制 ─────────────────────────────────────────────────────
  function setState(text, kind = "") {
    if (!dom) return;
    dom.state.innerHTML = `<i class="cx-dot ${kind}"></i>${esc(text)}`;
  }

  function paint() {
    const s = st.status || {};
    const acc = s.account || null;
    const install = s.install || {};
    const installed = !!s.installed || install.state === "done";
    const server = !!s.server;
    const turn = s.activeTurn;

    // 账户
    if (dom) {
      if (acc) {
        const who = acc.email || (acc.type === "apiKey" ? "API Key" : "已登录");
        dom.acct.innerHTML = `<b>${esc(who)}</b>${acc.planType ? `<span>${esc(acc.planType)}</span>` : ""}${acc.workspaceName ? ` · ${esc(acc.workspaceName)}` : ""}<div class="cx-acct-row"><button data-act="logout">退出登录</button></div>`;
      } else {
        dom.acct.innerHTML = `<b>未登录</b><span>登录 ChatGPT 后即可对话</span><div class="cx-acct-row"><button data-act="login">登录 ChatGPT</button></div>`;
      }
    }

    // 顶栏
    if (dom) {
      const name = st.thread && (st.thread.name || st.thread.preview) ? (st.thread.name || st.thread.preview) : (st.threadId ? "已恢复的任务" : "新任务");
      const models = (s.models || []).filter((m) => !m.hidden);
      const cur = models.find((m) => m.id === st.model) || models.find((m) => m.isDefault) || models[0];
      const efforts = cur && cur.supportedReasoningEfforts ? cur.supportedReasoningEfforts : [];
      dom.head.innerHTML = `<div class="cx-title">${esc(name)}</div>`
        + (models.length ? `<span class="cx-chip">模型 <select id="cx-model">${models.map((m) => `<option value="${esc(m.id)}"${cur && m.id === cur.id ? " selected" : ""}>${esc(m.displayName || m.id)}</option>`).join("")}</select></span>` : "")
        + (efforts.length ? `<span class="cx-chip">思考 <select id="cx-effort"><option value="">默认</option>${efforts.map((x) => `<option value="${esc(x.reasoningEffort)}"${x.reasoningEffort === st.effort ? " selected" : ""}>${esc(x.reasoningEffort)}</option>`).join("")}</select></span>` : "")
        + `<span class="cx-chip" data-act="new" title="换一个工作目录开始新任务">目录 ${esc(st.cwd || s.cwd || "工作区")}</span>`;
      const msel = $("cx-model"), esel = $("cx-effort");
      if (msel) msel.addEventListener("change", () => { st.model = msel.value; LS.set("model", st.model); saveSettings(); paint(); });
      if (esel) esel.addEventListener("change", () => { st.effort = esel.value; LS.set("effort", st.effort); saveSettings(); });
    }

    // 线程列表
    paintThreads();

    // 状态行
    if (dom) {
      if (!installed) setState("Codex 引擎未安装", "err");
      else if (install.state === "installing") setState(`安装中 ${install.total ? Math.round((install.done || 0) / install.total * 100) + "%" : ""}`, "busy");
      else if (turn) setState("Codex 正在运行…", "busy");
      else if (server) setState(acc ? "就绪" : "未登录", acc ? "" : "err");
      else setState("引擎未启动", "idle");
      dom.send.disabled = !installed || st.busy;
      dom.stop.classList.toggle("hidden", !turn);
      dom.send.classList.toggle("hidden", !!turn);
      dom.cwd.textContent = st.cwd || s.cwd || "";
      dom.cwd.title = st.cwd || s.cwd || "";
    }
    paintBoot();
    paintApprovals();
  }

  function paintBoot() {
    if (!dom) return;
    const s = st.status || {}, install = s.install || {};
    const installed = !!s.installed || install.state === "done";
    let h = "";
    if (!installed) {
      const pct = install.total ? Math.min(100, Math.round((install.done || 0) / install.total * 100)) : 0;
      h += `<div class="cx-install"><b>先装 Codex 引擎</b>
        官方 <span class="mono">codex-app-server</span> 静态二进制，约 ${fmtSize(88007340) || "84 MB"}。
        装好后以本应用 uid 运行，不 root；不确定的命令会先在这里等你确认。
        <div class="cx-bar"><i style="width:${install.state === "installing" ? pct : 0}%"></i></div>
        <div class="tiny">${install.state === "installing" ? esc(install.phase || "下载中…") + (install.total ? ` · ${fmtSize(install.done || 0)} / ${fmtSize(install.total)}` : "") : install.state === "error" ? "✗ " + esc(install.error || "安装失败") : "版本 " + esc(s.version || "")}</div>
        <button data-act="install"${install.state === "installing" ? " disabled" : ""}>${install.state === "installing" ? "安装中…" : install.state === "error" ? "重试安装" : "安装 Codex 引擎"}</button></div>`;
    }
    if (st.status && st.status.lastError) h += `<div class="cx-appr" style="max-width:920px;margin:0 auto 10px"><div class="cx-appr-h">引擎报错</div><pre>${esc(st.status.lastError)}</pre></div>`;
    if (dom.boot.innerHTML !== h) dom.boot.innerHTML = h;
    const empty = installed && !dom.msgs.children.length;
    if (empty) dom.msgs.innerHTML = `<div class="cx-empty"><b>开始一个任务</b>${(st.status && st.status.account) ? "Codex 会在当前工作目录里读代码、改文件、跑命令；需要确认的会停在这里。" : "先点左边「登录 ChatGPT」，再开始。"}</div>`;
    else if (!empty && dom.msgs.firstElementChild && dom.msgs.firstElementChild.className === "cx-empty") dom.msgs.innerHTML = "";
  }

  function paintThreads() {
    if (!dom) return;
    const threads = (st.status && st.status.threads) || st.threads || [];
    if (!threads.length) { dom.threads.innerHTML = `<div class="tiny" style="padding:8px 9px;color:var(--fg3)">还没有任务</div>`; return; }
    dom.threads.innerHTML = threads.map((t) => {
      const name = t.name || t.preview || "未命名任务";
      return `<button class="cx-th${t.id === st.threadId ? " on" : ""}" data-act="open-thread" data-id="${esc(t.id)}"><b>${esc(name)}</b><small>${esc(t.cwd || "")}${t.updatedAt ? " · " + esc(relTime(t.updatedAt * 1000)) : ""}</small></button>`;
    }).join("");
  }

  // ── 审批 / 登录卡 ───────────────────────────────────────────────────
  function paintApprovals() {
    if (!dom) return;
    let h = "";
    if (st.login) {
      const L = st.login;
      h += `<div class="cx-login"><b>登录 ChatGPT</b><br>在浏览器打开下方地址，输入一次性代码：<br>
        <span class="tiny mono">${esc(L.verificationUrl || "")}</span><br><code>${esc(L.userCode || "")}</code>
        <div class="cx-appr-acts"><button data-act="login-open">打开浏览器</button><button data-act="login-copy">复制代码</button><button data-act="login-cancel">取消</button></div>
        <div class="tiny" style="color:var(--fg3);margin-top:5px">登录完成后窗口会自动继续；不要把这个码发给任何人。</div></div>`;
    }
    for (const [id, p] of st.approvals) h += approvalHtml(id, p);
    if (dom.apprs.innerHTML !== h) dom.apprs.innerHTML = h;
  }

  function approvalHtml(id, p) {
    const m = p.method, q = p.params || {};
    const ida = esc(id);
    if (m === "item/commandExecution/requestApproval") {
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">Codex 想运行命令</div>
        ${q.reason ? `<div class="tiny">${esc(q.reason)}</div>` : ""}
        <pre>${esc(q.command || "")}</pre>${q.cwd ? `<div class="tiny mono">${esc(q.cwd)}</div>` : ""}
        <div class="cx-appr-acts"><button class="ok" data-act="approve" data-id="${ida}" data-decision="accept">允许一次</button>
        <button data-act="approve" data-id="${ida}" data-decision="acceptForSession">本任务都允许</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="cancel">拒绝并中止</button></div></div>`;
    }
    if (m === "item/fileChange/requestApproval") {
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">Codex 想修改文件</div>
        ${q.reason ? `<div class="tiny">${esc(q.reason)}</div>` : "<div class=\"tiny\">改动内容在对话里的文件卡上。</div>"}
        <div class="cx-appr-acts"><button class="ok" data-act="approve" data-id="${ida}" data-decision="accept">允许一次</button>
        <button data-act="approve" data-id="${ida}" data-decision="acceptForSession">本任务都允许</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="cancel">拒绝并中止</button></div></div>`;
    }
    if (m === "item/permissions/requestApproval") {
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">Codex 请求额外权限</div>
        ${q.reason ? `<div class="tiny">${esc(q.reason)}</div>` : ""}
        <pre>${esc(JSON.stringify(q.permissions || {}, null, 2))}</pre>
        <div class="tiny">coxdragon 不会自动授予额外权限；继续表示只按当前沙箱跑。</div>
        <div class="cx-appr-acts"><button class="ok" data-act="approve" data-id="${ida}" data-decision="accept">继续</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button></div></div>`;
    }
    if (m === "item/tool/requestUserInput") {
      const qs = Array.isArray(q.questions) ? q.questions : [];
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">Codex 需要你回答</div>
        ${qs.map((x) => `<div class="cx-q">${esc(x.header || "问题")}<small>${esc(x.question || "")}</small></div>`
          + (Array.isArray(x.options) && x.options.length
            ? `<select data-q="${esc(x.id)}"><option value="">请选择…</option>${x.options.map((o) => `<option value="${esc(o.label)}">${esc(o.label)}${o.description ? " — " + esc(o.description) : ""}</option>`).join("")}</select>`
            : `<input type="${x.isSecret ? "password" : "text"}" data-q="${esc(x.id)}" placeholder="回答…">`)).join("")}
        <div class="cx-appr-acts"><button class="ok" data-act="approve-input" data-id="${ida}">提交</button>
        <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">跳过</button></div></div>`;
    }
    if (m === "mcpServer/elicitation/request") {
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">MCP 请求输入</div>
        <pre>${esc(JSON.stringify(q, null, 2).slice(0, 4000))}</pre>
        <div class="cx-appr-acts"><button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button></div></div>`;
    }
    return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">Codex 等待确认</div><pre>${esc(JSON.stringify(q, null, 2).slice(0, 4000))}</pre>
      <div class="cx-appr-acts"><button class="ok" data-act="approve" data-id="${ida}" data-decision="accept">允许</button>
      <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button></div></div>`;
  }

  // ── 消息条目 ───────────────────────────────────────────────────────
  function getEntry(item, turnId) {
    let it = st.items.get(item.id);
    if (it) return it;
    it = { id: item.id, type: item.type, turnId, data: item, text: "", out: "", el: null, body: null, raf: 0, outRaf: 0 };
    if (item.type === "agentMessage") it.text = item.text || "";
    if (item.type === "reasoning") it.text = (item.summary || []).join("\n") || (item.content || []).join("\n");
    if (item.type === "commandExecution") it.out = item.aggregatedOutput || "";
    const d = document.createElement("div");
    d.dataset.item = item.id;
    it.el = d;
    it.body = d;
    st.items.set(item.id, it);
    const empty = dom.msgs.querySelector(".cx-empty");
    if (empty) empty.remove();
    dom.msgs.appendChild(d);
    return it;
  }

  function renderItem(item, turnId) {
    if (!dom || !item || !item.id) return;
    ensureDom();
    const it = getEntry(item, turnId);
    it.data = item;
    if (item.type === "agentMessage" && item.text != null) it.text = item.text;
    if (item.type === "reasoning") it.text = (item.summary || []).join("\n") || (item.content || []).join("\n") || it.text;
    if (item.type === "commandExecution" && item.aggregatedOutput != null) it.out = item.aggregatedOutput;
    paintItem(it);
  }

  function paintItem(it) {
    const d = it.el, x = it.data || {};
    const stick = nearBottom();
    switch (x.type) {
      case "userMessage": {
        const text = (x.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n");
        d.className = "cx-msg cx-user";
        d.innerHTML = `<div class="cx-role">你</div><div class="cx-body">${esc(text)}</div>`;
        break;
      }
      case "agentMessage": {
        d.className = "cx-msg cx-agent";
        if (!d.firstChild) d.innerHTML = `<div class="cx-role">Codex</div><div class="cx-body"></div>`;
        const body = d.querySelector(".cx-body");
        if (body && !it.raf) it.raf = requestAnimationFrame(() => { it.raf = 0; body.innerHTML = md(it.text); });
        break;
      }
      case "reasoning": {
        d.className = "cx-think";
        if (!d.firstChild) d.innerHTML = `<details><summary>思考</summary><div class="cx-think-body"></div></details>`;
        const b = d.querySelector(".cx-think-body");
        if (b) b.textContent = it.text || "";
        break;
      }
      case "commandExecution": {
        d.className = "cx-tool";
        const stt = x.status || "inProgress";
        const cls = stt === "completed" ? "ok" : stt === "failed" || stt === "declined" ? "err" : "run";
        if (!d.firstChild) d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">SHELL</span><code></code><span class="cx-tool-state"></span></div><pre class="cx-out"></pre>`;
        d.querySelector("code").textContent = x.command || "";
        const sEl = d.querySelector(".cx-tool-state");
        sEl.className = "cx-tool-state " + cls;
        sEl.textContent = stt === "inProgress" ? "运行中" : stt === "completed" ? (x.exitCode != null ? "退出 " + x.exitCode : "完成") : stt === "declined" ? "已拒绝" : "失败";
        const out = d.querySelector(".cx-out");
        out.textContent = it.out || "";
        out.style.display = it.out ? "" : "none";
        break;
      }
      case "fileChange": {
        d.className = "cx-tool";
        const ch = Array.isArray(x.changes) ? x.changes : [];
        if (!d.firstChild) d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">PATCH</span><code></code><span class="cx-tool-state"></span></div><div class="cx-changes"></div>`;
        d.querySelector("code").textContent = ch.length ? ch.map((c) => c.path).join(", ") : "文件改动";
        const sEl = d.querySelector(".cx-tool-state");
        sEl.className = "cx-tool-state " + (x.status === "completed" ? "ok" : x.status === "failed" || x.status === "declined" ? "err" : "run");
        sEl.textContent = x.status === "completed" ? "完成" : x.status === "failed" ? "失败" : x.status === "declined" ? "已拒绝" : "进行中";
        const box = d.querySelector(".cx-changes");
        box.innerHTML = ch.map((c) => `<details class="cx-change"><summary><b>${esc(c.kind || "")}</b> <code>${esc(c.path || "")}</code></summary><pre class="cx-out">${esc(c.diff || "")}</pre></details>`).join("");
        break;
      }
      case "mcpToolCall": {
        d.className = "cx-tool";
        if (!d.firstChild) d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">MCP</span><code></code><span class="cx-tool-state"></span></div><details><pre class="cx-out"></pre></details>`;
        d.querySelector("code").textContent = `${x.server || "mcp"} / ${x.tool || ""}`;
        const sEl = d.querySelector(".cx-tool-state");
        sEl.className = "cx-tool-state " + (x.status === "completed" ? "ok" : x.status === "failed" ? "err" : "run");
        sEl.textContent = x.status === "completed" ? "完成" : x.status === "failed" ? "失败" : "运行中";
        const pre = d.querySelector("pre");
        pre.textContent = JSON.stringify({ arguments: x.arguments, result: x.result, error: x.error }, null, 2).slice(0, 20000);
        break;
      }
      case "plan": {
        d.className = "cx-plan";
        d.innerHTML = `<div class="cx-plan-h">计划</div><div>${md(x.text || it.text || "")}</div>`;
        break;
      }
      case "webSearch": {
        d.className = "cx-tool";
        d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">WEB</span><code>${esc(x.query || "")}</code></div>`;
        break;
      }
      case "imageView": {
        d.className = "cx-tool";
        d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">IMAGE</span><code>${esc(x.path || "")}</code></div>`;
        break;
      }
      case "contextCompaction": {
        d.className = "cx-think";
        d.textContent = "上下文已压缩";
        break;
      }
      default: {
        d.className = "cx-tool";
        if (!d.firstChild) d.innerHTML = `<div class="cx-tool-head"><span class="cx-tool-kind">${esc(x.type || "ITEM")}</span><code></code></div><pre class="cx-out"></pre>`;
        d.querySelector("code").textContent = x.id || "";
        d.querySelector("pre").textContent = JSON.stringify(x, null, 2).slice(0, 8000);
      }
    }
    if (stick) scrollBottom();
  }

  function appendDelta(itemId, delta, kind, turnId) {
    if (!dom || !itemId || !delta) return;
    let it = st.items.get(itemId);
    if (!it) {
      const type = kind === "reasoning" ? "reasoning" : kind === "output" ? "commandExecution" : "agentMessage";
      it = getEntry({ id: itemId, type, text: "", status: "inProgress", command: "" }, turnId);
      paintItem(it);
    }
    if (kind === "output") {
      it.out += delta;
      if (!it.outRaf) it.outRaf = requestAnimationFrame(() => {
        it.outRaf = 0;
        const out = it.el.querySelector(".cx-out");
        if (out) { const stick = nearBottom(); out.textContent = it.out; out.style.display = ""; if (stick) scrollBottom(); }
      });
      return;
    }
    it.text += delta;
    if (it.type === "plan") {
      const body = it.el.querySelector("div:not(.cx-plan-h)");
      if (body) body.innerHTML = md(it.text);
      return;
    }
    if (kind === "reasoning") {
      const b = it.el.querySelector(".cx-think-body");
      if (b) b.textContent = it.text;
      return;
    }
    const body = it.el.querySelector(".cx-body");
    if (body && !it.raf) it.raf = requestAnimationFrame(() => { it.raf = 0; body.innerHTML = md(it.text); if (nearBottom()) scrollBottom(); });
  }

  function nearBottom() {
    if (!dom) return true;
    return dom.log.scrollHeight - dom.log.scrollTop - dom.log.clientHeight < 90;
  }
  function scrollBottom() { if (dom) dom.log.scrollTop = dom.log.scrollHeight; }

  function clearMessages() {
    st.items.clear();
    st.approvals.clear();
    if (dom) { dom.msgs.innerHTML = ""; dom.apprs.innerHTML = ""; }
  }

  function hydrateThread(t) {
    clearMessages();
    if (!t) return;
    const turns = Array.isArray(t.turns) ? t.turns : [];
    for (const turn of turns) for (const item of (turn.items || [])) renderItem(item, turn.id);
    if (!turns.length) paintBoot();
  }

  // ── 事件 ───────────────────────────────────────────────────────────
  function connect() {
    if (st.es) return;
    let es;
    try { es = new EventSource("/api/codex/events"); } catch (e) { setState("事件流建不起来", "err"); return; }
    st.es = es;
    es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (x) { console.warn("[codex] bad event", x); } };
    es.onerror = () => { setState("事件流断开，正在重连…", "err"); };
  }
  function disconnect() { if (st.es) { try { st.es.close(); } catch {} st.es = null; } }

  function handle(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === "status") { st.status = ev.status; paint(); return; }
    if (ev.type === "install") {
      if (st.status) st.status.install = ev.install;
      else st.status = { install: ev.install };
      if (ev.install && ev.install.installed) { st.status.installed = true; refreshSoon(); }
      paint();
      return;
    }
    if (ev.type === "server") {
      if (st.status) st.status.server = ev.state === "ready";
      if (ev.state === "exited" && st.status) st.status.lastError = "Codex 引擎退出了" + (ev.code != null ? `（code ${ev.code}）` : "");
      if (ev.state === "ready" && st.status) st.status.lastError = "";
      paint();
      if (ev.state === "ready") refreshSoon();
      return;
    }
    if (ev.type === "thread") {
      if (ev.thread) { st.thread = ev.thread; st.threadId = ev.thread.id; LS.set("thread", st.threadId); if (!st.cwd) st.cwd = ev.thread.cwd || ""; }
      paint();
      return;
    }
    if (ev.type === "turn") { if (st.status) st.status.activeTurn = ev.turn; paint(); if (ev.turn) scrollBottom(); return; }
    if (ev.type === "approval") { st.approvals.set(String(ev.id), { method: ev.method, params: ev.params }); paintApprovals(); scrollBottom(); return; }
    if (ev.type === "approval-done") { st.approvals.delete(String(ev.id)); paintApprovals(); return; }
    if (ev.type !== "rpc") return;
    const m = ev.method, p = ev.params || {};
    switch (m) {
      case "item/started":
      case "item/completed":
        if (p.item) renderItem(p.item, p.turnId);
        break;
      case "item/agentMessage/delta": appendDelta(p.itemId, p.delta, "text", p.turnId); break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": appendDelta(p.itemId, p.delta, "reasoning", p.turnId); break;
      case "item/reasoning/summaryPartAdded": appendDelta(p.itemId, "\n", "reasoning", p.turnId); break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": appendDelta(p.itemId, p.delta, "output", p.turnId); break;
      case "item/plan/delta": appendDelta(p.itemId, p.delta, "text", p.turnId); break;
      case "turn/started":
        if (st.status) st.status.activeTurn = p.turn || { id: p.turnId, status: "inProgress" };
        setState("Codex 正在运行…", "busy"); paint();
        break;
      case "turn/completed":
        if (st.status) st.status.activeTurn = null;
        if (p.turn && p.turn.error) {
          addError(p.turn.error.message || "这一轮失败了");
          st.lastWarn = p.turn.error.message || "";
        }
        paint(); refreshThreadsSoon();
        break;
      case "thread/started":
        if (p.thread) { st.thread = p.thread; st.threadId = p.thread.id; LS.set("thread", st.threadId); paint(); }
        break;
      case "thread/status/changed":
        if (p.status && p.status.type === "systemError") addError("线程出错，可以重新开始一个任务。");
        break;
      case "error":
        addError((p.error && p.error.message) || "Codex 报错");
        break;
      case "warning":
      case "configWarning":
        if (p.message && p.message !== st.lastWarn) { st.lastWarn = p.message; toast(p.message); }
        break;
      case "account/login/completed":
        if (p.success) { st.login = null; toast("登录成功"); refreshSoon(); }
        else { toast("登录失败" + (p.error ? "：" + p.error : ""), true); }
        paint();
        break;
      case "account/updated":
        refreshSoon();
        break;
      case "model/rerouted":
        toast("模型已切换到 " + (p.model || p.to || "默认"));
        refreshSoon();
        break;
      case "serverRequest/resolved":
        if (p.id != null) { st.approvals.delete(String(p.id)); paintApprovals(); }
        break;
    }
  }

  function addError(msg) {
    if (!dom || !msg) return;
    const d = document.createElement("div");
    d.className = "cx-appr";
    d.innerHTML = `<div class="cx-appr-h">出错了</div><div>${esc(msg)}</div>`;
    const empty = dom.msgs.querySelector(".cx-empty"); if (empty) empty.remove();
    dom.msgs.appendChild(d);
    scrollBottom();
  }

  let refreshTimer = 0, threadTimer = 0;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 350); }
  function refreshThreadsSoon() { clearTimeout(threadTimer); threadTimer = setTimeout(loadThreads, 600); }

  // ── 请求 ───────────────────────────────────────────────────────────
  const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  async function refresh() {
    if (!st.open) return;
    try {
      const s = await api("/api/codex/status");
      st.status = s;
      st.installed = !!s.installed;
      if (!st.cwd) st.cwd = s.cwd || "";
      if (s.activeThread && !st.thread) { st.thread = s.activeThread; st.threadId = s.activeThread.id; }
      if (!st.model) {
        const ms = (s.models || []).filter((m) => !m.hidden);
        const def = ms.find((m) => m.isDefault) || ms[0];
        if (def) st.model = def.id;
      }
      paint();
      loadThreads();
    } catch (e) {
      setState("网关没答话：" + e.message, "err");
    }
  }

  async function loadThreads() {
    if (!st.open) return;
    try {
      const r = await api("/api/codex/threads");
      st.threads = r.threads || [];
      if (st.status) st.status.threads = st.threads;
      paintThreads();
      if (!st.autoResumed && st.threadId && st.threads.some((t) => t.id === st.threadId)) { st.autoResumed = true; openThread(st.threadId); }
    } catch { /* 未安装 / 引擎没起来时不用报 */ }
  }

  async function install() {
    try { await post("/api/codex/install"); toast("开始下载 Codex 引擎"); refreshSoon(); }
    catch (e) { toast(e.message, true); }
  }

  async function newThread(cwd) {
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    let dir = cwd;
    if (!dir) {
      const cur = st.cwd || (st.status && st.status.cwd) || "";
      const v = prompt("工作目录（留空用默认工作区）", cur);
      if (v === null) return;
      dir = v.trim();
    }
    try {
      const r = await post("/api/codex/thread", { cwd: dir });
      clearMessages();
      st.thread = r.thread; st.threadId = r.thread && r.thread.id || "";
      if (st.threadId) LS.set("thread", st.threadId);
      st.cwd = (r.thread && r.thread.cwd) || dir || st.cwd;
      LS.set("cwd", st.cwd);
      paint(); loadThreads();
      dom.input.focus();
      toast("新任务已开始");
    } catch (e) { toast(e.message, true); }
  }

  async function openThread(id) {
    if (!id) return;
    try {
      const r = await post("/api/codex/open-thread", { threadId: id });
      st.thread = r.thread; st.threadId = id; LS.set("thread", id);
      st.cwd = (r.thread && r.thread.cwd) || st.cwd;
      hydrateThread(r.thread);
      paint(); scrollBottom();
    } catch (e) { toast(e.message, true); }
  }

  function send() {
    if (!dom || st.busy) return;
    const text = dom.input.value.trim();
    if (!text) return;
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    if (!st.status.account) return toast("先登录 ChatGPT", true);
    st.busy = true; dom.send.disabled = true;
    post("/api/codex/turn", { text }).then(() => {
      dom.input.value = ""; dom.input.style.height = "auto"; scrollBottom();
      if (st.status) st.status.activeTurn = st.status.activeTurn || { id: "", status: "inProgress" };
      paint();
    }).catch((e) => {
      if (st.status) st.status.activeTurn = null;
      addError(e.message);
      toast(e.message, true);
      paint();
    }).finally(() => { st.busy = false; if (dom) dom.send.disabled = false; });
  }

  async function interrupt() {
    try { await post("/api/codex/interrupt"); toast("已请求停止"); }
    catch (e) { toast(e.message, true); }
  }

  async function login() {
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    try {
      const r = await post("/api/codex/login");
      if (r && r.type === "chatgptDeviceCode") { st.login = r; paintApprovals(); }
      else if (r && r.type === "chatgpt" && r.authUrl) {
        st.login = { loginId: r.loginId, verificationUrl: r.authUrl, userCode: "" };
        paintApprovals(); openLoginUrl();
      } else toast("已发起登录，请稍候");
    } catch (e) { toast(e.message, true); }
  }

  async function cancelLogin() {
    const l = st.login; st.login = null; paintApprovals();
    if (l && l.loginId) { try { await post("/api/codex/login-cancel", { loginId: l.loginId }); } catch {} }
  }

  function openLoginUrl() {
    const u = st.login && (st.login.verificationUrl || st.login.authUrl);
    if (!u) return;
    if (!/^https:\/\//i.test(u)) return toast("登录地址不是 https，没打开", true);
    try { if (window.CCApp && CCApp.openUrl) return CCApp.openUrl(u); } catch {}
    window.open(u, "_blank", "noopener");
  }

  async function logout() {
    if (!confirm("退出 Codex 的 ChatGPT 登录？")) return;
    try { await post("/api/codex/logout"); st.login = null; toast("已退出"); refreshSoon(); }
    catch (e) { toast(e.message, true); }
  }

  function saveSettings() {
    post("/api/codex/settings", { model: st.model, effort: st.effort }).catch(() => {});
  }

  async function approve(id, decision, card) {
    if (!id) return;
    if (card) card.style.opacity = ".55";
    try { await post("/api/codex/approve", { id, decision }); st.approvals.delete(String(id)); paintApprovals(); }
    catch (e) { if (card) card.style.opacity = ""; toast(e.message, true); }
  }

  async function approveInput(id, card) {
    if (!id || !card) return;
    const answers = {};
    for (const el of card.querySelectorAll("select[data-q],input[data-q]")) {
      const k = el.dataset.q, v = String(el.value || "").trim();
      if (k && v) answers[k] = { answers: [v] };
    }
    if (!Object.keys(answers).length) return toast("先选一个答案", true);
    try { await post("/api/codex/approve", { id, answers, decision: "accept" }); st.approvals.delete(String(id)); paintApprovals(); }
    catch (e) { toast(e.message, true); }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────
  function onOpen() {
    ensureDom();
    st.open = true;
    const pb = document.getElementById("page-body");
    if (pb) pb.classList.add("cx-on");
    connect();
    refresh();
    setTimeout(scrollBottom, 60);
  }
  function onHide() {
    st.open = false;
    const pb = document.getElementById("page-body");
    if (pb) pb.classList.remove("cx-on");
    disconnect();
  }

  ensureDom();
  window.CODEX = { onOpen, onHide, refresh, openThread, newThread, get state() { return st; } };
})();
