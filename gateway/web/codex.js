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

  const t = (s) => window.I18N && I18N.t ? I18N.t(s) : s;

  const LS = {
    get: (k, d) => { try { return localStorage.getItem("cx." + k) || d; } catch { return d; } },
    set: (k, v) => { try { v ? localStorage.setItem("cx." + k, v) : localStorage.removeItem("cx." + k); } catch {} },
  };
  const st = {
    status: null, es: null, open: false,
    thread: null, threadId: LS.get("thread", ""),
    items: new Map(), approvals: new Map(),
    login: null, model: LS.get("model", ""), effort: LS.get("effort", ""), cwd: LS.get("cwd", ""),
    busy: false, bootRaf: 0, lastWarn: "", search: "",
  };

  // ── DOM ─────────────────────────────────────────────────────────────
  let dom = null;
  function ensureDom() {
    if (dom) return dom;
    root.innerHTML = `
<div class="cx">
  <main class="cx-main">
    <header class="cx-head" id="cx-head"></header>
    <div class="cx-log" id="cx-log"><div id="cx-boot"></div><div id="cx-msgs"></div></div>
    <div class="cx-dock">
      <div class="cx-approvals" id="cx-approvals"></div>
      <div class="cx-row">
        <textarea id="cx-input" rows="1" placeholder="${esc(t("有什么想一起完成的？"))}" aria-label="${esc(t("消息输入框"))}" autocomplete="off" spellcheck="false"></textarea>
        <button class="cx-send" data-act="send" id="cx-send" aria-label="${esc(t("发送"))}" title="${esc(t("发送"))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
        <button class="cx-stop hidden" data-act="stop" id="cx-stop" aria-label="${esc(t("停止"))}" title="${esc(t("停止"))}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>
      </div>
      <div class="cx-foot">
        <span id="cx-state"><i class="cx-dot idle"></i>未连接</span>
        <span id="cx-cwd"></span>
      </div>
    </div>
  </main>
</div>`;
    // Share the shell drawer so phones and tablets have one conversation sidebar.
    const sidebar = document.getElementById("cx-sidebar");
    if (sidebar) {
      sidebar.innerHTML = `<label class="cx-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input id="cx-search" type="search" placeholder="${t("搜索对话")}" aria-label="${t("搜索对话")}"></label><div class="cx-side-label">${t("最近对话")}</div><div class="cx-threads" id="cx-threads"></div><div class="cx-acct" id="cx-acct"></div>`;
      sidebar.addEventListener("click", onClick);
      $("cx-search").addEventListener("input", (e) => { st.search = e.target.value; paintThreads(); });
    }
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
    // Use cccodroid's code-copy and local-file link handlers, including Android fallbacks.
    if (CC.onCopyBtn) dom.log.addEventListener("click", CC.onCopyBtn);
    if (CC.onPathLink) dom.log.addEventListener("click", CC.onPathLink);
    return dom;
  }

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "new") return newThread(st.cwd || (st.status && st.status.cwd));
    if (act === "directory") return newThread();
    if (act === "suggest") {
      dom.input.value = el.dataset.prompt || "";
      dom.input.dispatchEvent(new Event("input")); dom.input.focus(); return;
    }
    if (act === "copy-message") {
      const item = st.items.get(el.closest("[data-item]").dataset.item);
      if (item) Promise.resolve(copyText(item.text)).then(ok => toast(t(ok ? "已复制" : "复制失败"), !ok));
      return;
    }
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
    if (act === "mcp-submit") return submitMcp(el.dataset.id, el.closest(".cx-appr"));
    if (act === "mcp-open-url") return openMcpUrl(el.dataset.id);
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
      if (dom.acct && acc) {
        const who = acc.email || (acc.type === "apiKey" ? "API Key" : "已登录");
        dom.acct.innerHTML = `<b>${esc(who)}</b>${acc.planType ? `<span>${esc(acc.planType)}</span>` : ""}${acc.workspaceName ? ` · ${esc(acc.workspaceName)}` : ""}<div class="cx-acct-row"><button data-act="logout">退出登录</button></div>`;
      } else if (dom.acct) {
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
        + `<span class="cx-chip" data-act="directory" title="换一个工作目录开始新任务">目录 ${esc(st.cwd || s.cwd || "工作区")}</span>`;
      const msel = $("cx-model"), esel = $("cx-effort");
      if (msel) msel.addEventListener("change", () => {
        st.model = msel.value; LS.set("model", st.model);
        // 换了模型：原来那档思考强度新模型不一定支持，不支持就退回默认
        const m = models.find((x) => x.id === st.model);
        if (m && st.effort && !(m.supportedReasoningEfforts || []).some((x) => x.reasoningEffort === st.effort)) {
          st.effort = ""; LS.set("effort", "");
        }
        saveSettings(); paint();
      });
      if (esel) esel.addEventListener("change", () => { st.effort = esel.value; LS.set("effort", st.effort); saveSettings(); });
    }

    // 线程列表
    paintThreads();

    // 状态行
    if (dom) {
      const ready = !!s.ready;
      if (!installed) setState("Codex 引擎未安装", "err");
      else if (install.state === "installing") setState(`安装中 ${install.total ? Math.round((install.done || 0) / install.total * 100) + "%" : ""}`, "busy");
      else if (!ready) setState("正在补齐代码模式组件…", "busy");
      else if (turn) setState("Codex 正在运行…", "busy");
      else if (server) setState(acc ? "就绪" : "未登录", acc ? "" : "err");
      else setState("引擎未启动", "idle");
      dom.send.disabled = !installed || !ready || st.busy;
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
    const ready = !!s.ready;
    let h = "";
    const pct = install.total ? Math.min(100, Math.round((install.done || 0) / install.total * 100)) : 0;
    if (!installed) {
      h += `<div class="cx-install"><b>先装 Codex 引擎</b>
        官方 <span class="mono">codex-app-server</span> 静态二进制，约 ${fmtSize(88007340) || "84 MB"}。
        装好后以本应用 uid 运行，不 root；不确定的命令会先在这里等你确认。
        <div class="cx-bar"><i style="width:${install.state === "installing" ? pct : 0}%"></i></div>
        <div class="tiny">${install.state === "installing" ? esc(install.phase || "下载中…") + (install.total ? ` · ${fmtSize(install.done || 0)} / ${fmtSize(install.total)}` : "") : install.state === "error" ? "✗ " + esc(install.error || "安装失败") : "版本 " + esc(s.version || "")}</div>
        <button data-act="install"${install.state === "installing" ? " disabled" : ""}>${install.state === "installing" ? "安装中…" : install.state === "error" ? "重试安装" : "安装 Codex 引擎"}</button></div>`;
    } else if (!ready) {
      // 0.166.0 的代码模式宿主是官方单独发的包；缺了它读文件 / 跑命令会失败
      h += `<div class="cx-install"><b>补齐 Codex 代码模式组件</b>
        官方 <span class="mono">codex-code-mode-host</span>，约 ${fmtSize(27023046) || "26 MB"}。
        没有它，Codex 能对话但读不了文件、也跑不了命令。
        <div class="cx-bar"><i style="width:${install.state === "installing" ? pct : 0}%"></i></div>
        <div class="tiny">${install.state === "installing" ? esc(install.phase || "下载中…") + (install.total ? ` · ${fmtSize(install.done || 0)} / ${fmtSize(install.total)}` : "") : install.state === "error" ? "✗ " + esc(install.error || "安装失败") : "登录状态和任务都不受影响"}</div>
        <button data-act="install"${install.state === "installing" ? " disabled" : ""}>${install.state === "installing" ? "安装中…" : install.state === "error" ? "重试安装" : "下载组件"}</button></div>`;
    }
    if (st.status && st.status.lastError) h += `<div class="cx-appr" style="max-width:920px;margin:0 auto 10px"><div class="cx-appr-h">引擎报错</div><pre>${esc(st.status.lastError)}</pre></div>`;
    if (dom.boot.innerHTML !== h) dom.boot.innerHTML = h;
    const empty = ready && !dom.msgs.querySelector(":scope > :not(.cx-empty)");
    const emptyKey = String(!!(st.status && st.status.account));
    if (empty && (!dom.msgs.querySelector(".cx-empty") || dom.msgs.dataset.account !== emptyKey)) {
      dom.msgs.dataset.account = emptyKey;
      dom.msgs.innerHTML = `<div class="cx-empty"><span class="cx-greeting">coxdragon</span><b>${t("今天，一起完成什么？")}</b><p>${st.status && st.status.account ? t("从一个想法、一段代码，或一个问题开始。") : t("在侧栏登录 ChatGPT，开始你的第一个任务。")}</p><div class="cx-suggestions">${["了解这个项目的结构", "帮我实现一个新功能", "检查代码，找出潜在问题"].map(prompt => `<button data-act="suggest" data-prompt="${esc(t(prompt))}">${esc(t(prompt))}<span aria-hidden="true">↗</span></button>`).join("")}</div></div>`;
    } else if (!empty && dom.msgs.firstElementChild && dom.msgs.firstElementChild.className === "cx-empty") dom.msgs.firstElementChild.remove();
  }

  function paintThreads() {
    if (!dom || !dom.threads) return;
    const allThreads = (st.status && st.status.threads) || st.threads || [];
    const threads = allThreads.filter(t => !st.search || `${t.name || ""} ${t.preview || ""} ${t.cwd || ""}`.toLocaleLowerCase().includes(st.search.toLocaleLowerCase()));
    if (!threads.length) { dom.threads.innerHTML = `<div class="tiny" style="padding:8px 9px;color:var(--fg3)">${esc(t(st.search ? "没有找到对话" : "还没有对话"))}</div>`; return; }
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
    if (dom.apprs.innerHTML !== h) {
      // Adding or resolving another request must not discard a form the user is filling in.
      const drafts = new Map();
      const key = el => JSON.stringify([el.closest("[data-appr]").dataset.appr, el.dataset.mcpField]);
      for (const el of dom.apprs.querySelectorAll("[data-mcp-field]")) drafts.set(key(el), el.multiple ? Array.from(el.options).filter(o => o.selected).map(o => o.value) : el.value);
      dom.apprs.innerHTML = h;
      for (const el of dom.apprs.querySelectorAll("[data-mcp-field]")) if (drafts.has(key(el))) {
        const value = drafts.get(key(el));
        if (el.multiple) { for (const option of el.options) option.selected = value.includes(option.value); }
        else el.value = value;
      }
    }
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
      const adapter = window.CXMcpElicitation;
      const urlMode = q.mode === "url", formMode = ["form", "openai/form", "openaiForm"].includes(q.mode);
      return `<div class="cx-appr" data-appr="${ida}"><div class="cx-appr-h">MCP 请求输入${q.serverName ? " · " + esc(q.serverName) : ""}</div>
        <div class="cx-mcp-message">${esc(q.message || "")}</div>
        ${urlMode ? `<div class="cx-mcp-url">${esc(q.url || "")}</div>` : formMode && adapter ? adapter.formHtml(q.requestedSchema, esc) : '<div>暂时无法显示这种输入请求。</div>'}
        <div class="cx-appr-acts">${urlMode ? `<button data-act="mcp-open-url" data-id="${ida}">打开网页</button><button class="ok" data-act="approve" data-id="${ida}" data-decision="accept">已完成，继续</button>` : formMode && adapter ? `<button class="ok" data-act="mcp-submit" data-id="${ida}">提交并继续</button>` : ""}
        <button class="no" data-act="approve" data-id="${ida}" data-decision="decline">拒绝</button><button data-act="approve" data-id="${ida}" data-decision="cancel">取消</button></div></div>`;
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
        if (!d.firstChild) {
          d.innerHTML = `<div class="cx-role">Codex</div><div class="cx-body"></div><div class="msg-acts"></div>`;
          if (CC.actBtn) {
            const actions = d.querySelector(".msg-acts");
            actions.innerHTML = CC.actBtn("copy", t("复制"));
            actions.querySelector("button").dataset.act = "copy-message";
          }
        }
        const body = d.querySelector(".cx-body");
        if (body && !it.raf) it.raf = requestAnimationFrame(() => { it.raf = 0; body.innerHTML = md(it.text); if (CC.enhanceMd) CC.enhanceMd(body); });
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
      if (ev.install) {
        st.status.installed = !!ev.install.installed;
        st.status.ready = !!ev.install.ready;
        if (ev.install.host) st.status.host = ev.install.host;
        if (ev.install.ready) { st.hostAuto = false; refreshSoon(); }
      }
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
      case "configWarning": {
        // warning 是 { message }；configWarning 是 { summary, details }
        const w = p.message || p.summary;
        if (w && w !== st.lastWarn) { st.lastWarn = w; toast(w); }
        break;
      }
      case "account/login/completed":
        if (p.success) {
          st.login = null; toast("登录成功"); refreshSoon();
          // 顶栏 / 抽屉底部也按 Codex 的账户更新一次，不用等 45 秒的轮询
          try { window.dispatchEvent(new CustomEvent("cc:codex-account")); } catch {}
        } else if (st.login) {   // 用户主动取消时 st.login 已清掉，不再报失败；真失败把过期的一次性码收掉
          st.login = null;
          toast("登录失败" + (p.error ? "：" + p.error : ""), true);
        }
        paint();
        break;
      case "account/updated":
        refreshSoon();
        try { window.dispatchEvent(new CustomEvent("cc:codex-account")); } catch {}
        break;
      case "model/rerouted":
        // 官方参数是 { fromModel, toModel, reason }；以前按 p.model / p.to 读，永远显示「默认」
        toast("模型已切换到 " + (p.toModel || p.fromModel || "默认"));
        refreshSoon();
        break;
      case "serverRequest/resolved":
        if ((p.requestId ?? p.id) != null) { st.approvals.delete(String(p.requestId ?? p.id)); paintApprovals(); }
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
      st.ready = !!s.ready;
      // 只装过 app-server 的老安装：代码模式宿主缺着，自动补一次（约 26 MB，进度走 SSE 的 install 事件）
      if (s.installed && !s.ready && !st.hostAuto) {
        st.hostAuto = true;
        post("/api/codex/install").catch(() => { st.hostAuto = false; });
      }
      if (!st.cwd) st.cwd = s.cwd || "";
      if (s.activeThread && !st.thread) { st.thread = s.activeThread; st.threadId = s.activeThread.id; }
      const ms = (s.models || []).filter((m) => !m.hidden);
      // 以前选过的模型可能已经从清单里下架：退回默认，别让界面记着一个引擎不认识的 id
      if (st.model && ms.length && !ms.some((m) => m.id === st.model)) { st.model = ""; LS.set("model", ""); }
      if (!st.model) {
        const def = ms.find((m) => m.isDefault) || ms[0];
        if (def) { st.model = def.id; LS.set("model", st.model); }
      }
      // 网关进程重启后 S.model 是空的：把界面上记住的选择补回去，别出现「下拉框显示 A、引擎实际用默认 B」
      if (st.model && st.model !== (s.model || "")) saveSettings();
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
      if (CC.openPage) CC.openPage("codex");
      if (CC.closeDrawer) CC.closeDrawer();
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
      if (CC.openPage) CC.openPage("codex");
      if (CC.closeDrawer) CC.closeDrawer();
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

  async function submitMcp(id, card) {
    const p = st.approvals.get(String(id));
    if (!p || !card || !window.CXMcpElicitation) return toast("这条输入请求已经失效", true);
    let content;
    try { content = window.CXMcpElicitation.readForm(p.params.requestedSchema, card); }
    catch (e) { return toast(e.message || "请检查填写内容", true); }
    const button = card.querySelector('[data-act="mcp-submit"]');
    if (button) button.disabled = true;
    try { await post("/api/codex/approve", { id, decision: "accept", content }); st.approvals.delete(String(id)); paintApprovals(); }
    catch (e) { if (button) button.disabled = false; toast(e.message, true); }
  }

  function openMcpUrl(id) {
    const p = st.approvals.get(String(id));
    if (!p || !p.params || p.params.mode !== "url") return;
    const raw = p.params.url || "";
    let url;
    try { url = new URL(raw); } catch { return toast("网页地址无效", true); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return toast("网页地址必须使用 HTTPS", true);
    try { if (window.CCApp && CCApp.openUrl) return CCApp.openUrl(url.href); } catch {}
    window.open(url.href, "_blank", "noopener");
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

  // 从浏览器登录完回到应用：事件流可能被系统挂起、错过 account/login/completed，
  // 回到前台先补一次状态，别让登录卡片一直挂着。
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !st.open) return;
    refresh();
    if (!st.es) connect();
  });

  ensureDom();
  window.CODEX = { onOpen, onHide, refresh, openThread, newThread, get state() { return st; } };
  // app.js 的启动可能在 codex.js 之前就把 Codex 页切了出来（19-boot 的 setTimeout）：那时
  // window.CODEX 还没挂，onOpen 没被调用，页面会停在「未连接」。这里补一次。
  try {
    const pg = document.getElementById("pages"), tab = document.getElementById("tab-codex");
    if (pg && !pg.classList.contains("hidden") && tab && !tab.classList.contains("hidden")) onOpen();
  } catch {}
})();
