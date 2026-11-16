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
  const t = window.I18N ? I18N.t : (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v && k in v ? v[k] : m);
  const icons = {
    panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    menu: '<path d="M4 8h16M4 16h11"/>',
    edit: '<path d="m16 4 4 4M14 6l4-4 4 4-4 4-8 8-5 1 1-5 8-8Z"/><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
    diff: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 15h8M12 12v6"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10M8 15c7 0 10-2 10-7"/>',
    arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M6 6l1.5 1.5m9 9L18 18M6 18l1.5-1.5m9-9L18 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  };
  const ico = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.folder}</svg>`;
  const leaf = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t("工作区");

  const LS = {
    get: (k, d) => { try { return localStorage.getItem("cx." + k) || d; } catch { return d; } },
    set: (k, v) => { try { v ? localStorage.setItem("cx." + k, v) : localStorage.removeItem("cx." + k); } catch {} },
  };
  const st = {
    status: null, es: null, open: false,
    thread: null, threadId: LS.get("thread", ""),
    items: new Map(), approvals: new Map(), errors: new Map(),
    login: null, model: LS.get("model", ""), effort: LS.get("effort", ""), cwd: LS.get("cwd", ""),
    busy: false, bootRaf: 0, lastWarn: "",
    projects: [], query: "", pins: [], running: new Map(), endedTurns: new Set(), collapsed: new Set(),
    review: false, git: null, gitError: "", gitBusy: false, diff: "", diffFile: "", diffBusy: false,
    switching: false, viewSeq: 0, gitSeq: 0, diffSeq: 0, sidebar: false,
    onboarded: LS.get("onboarded", "") === "1", setupSession: false, setupBusy: "", setupError: "", setupStep: 0, threadsLoaded: false,
    settingsTab: "general", settingsBusy: false, extensions: null, extensionsBusy: false, extensionsError: "", extensionsSeq: 0,
    skipLogin: LS.get("skipLogin", "") === "1", connectionBusy: false,
  };
  try { st.pins = JSON.parse(LS.get("pins", "[]")); if (!Array.isArray(st.pins)) st.pins = []; } catch {}

  // ── DOM ─────────────────────────────────────────────────────────────
  let dom = null;
  function ensureDom() {
    if (dom) return dom;
    root.innerHTML = `
<div class="cx" id="cx-workbench">
  <button class="cx-scrim" data-act="sidebar-close" aria-label="${esc(t("关闭侧栏"))}" tabindex="-1"></button>
  <aside class="cx-side" aria-label="${esc(t("项目与任务"))}">
    <div class="cx-side-top">
      <button class="cx-brand" data-act="app-menu" title="${esc(t("应用菜单"))}"><span class="cx-mark">c<span>›</span></span><b>coxdragon</b></button>
      <button class="cx-icon" data-act="sidebar" title="${esc(t("切换侧栏"))}" aria-label="${esc(t("切换侧栏"))}">${ico("panel")}</button>
    </div>
    <button class="cx-new-task" data-act="new">${ico("plus")}<span>${esc(t("新任务"))}</span><kbd>Ctrl J</kbd></button>
    <label class="cx-search">${ico("search")}<input id="cx-search" type="search" placeholder="${esc(t("搜索任务"))}" aria-label="${esc(t("搜索任务"))}"></label>
    <div class="cx-side-label"><span>${esc(t("项目"))}</span><button class="cx-icon" data-act="add-project" title="${esc(t("添加项目"))}" aria-label="${esc(t("添加项目"))}">${ico("plus")}</button></div>
    <nav class="cx-threads" id="cx-threads" aria-label="${esc(t("任务"))}"></nav>
    <div class="cx-side-bottom"><div class="cx-acct" id="cx-acct"></div><button class="cx-settings" data-act="extensions">${ico("plus")}<span>${esc(t("技能与 MCP"))}</span></button><button class="cx-settings" data-act="settings">${ico("settings")}<span>${esc(t("设置"))}</span></button></div>
  </aside>
  <main class="cx-main">
    <header class="cx-head" id="cx-head">
      <button class="cx-icon cx-sidebar-toggle" data-act="sidebar" aria-label="${esc(t("切换侧栏"))}" aria-expanded="false"><span class="cx-desktop-panel">${ico("panel")}</span><span class="cx-phone-menu">${ico("menu")}</span></button>
      <button class="cx-mobile-model" data-act="mobile-tools" aria-haspopup="dialog" aria-controls="cx-mobile-menu" aria-expanded="false"><span>Codex</span>${ico("chevron")}</button>
      <div class="cx-heading"><span class="cx-title" id="cx-title"></span><button class="cx-project-link" data-act="choose-project" id="cx-project-name"></button></div>
      <span class="cx-branch" id="cx-branch"></span>
      <div class="cx-head-tools">
        <button class="cx-icon" data-act="files" title="${esc(t("文件浏览器"))}" aria-label="${esc(t("文件浏览器"))}">${ico("folder")}</button>
        <button class="cx-icon" data-act="terminal" title="${esc(t("终端"))}" aria-label="${esc(t("终端"))}">${ico("terminal")}</button>
        <button class="cx-review-toggle" data-act="review" id="cx-review-toggle" aria-expanded="false">${ico("diff")}<span>${esc(t("改动"))}</span><b id="cx-change-count">0</b></button>
      </div>
      <div class="cx-mobile-actions"><button class="cx-icon" data-act="new" aria-label="${esc(t("新任务"))}" title="${esc(t("新任务"))}">${ico("edit")}</button><button class="cx-icon" data-act="mobile-more" aria-label="${esc(t("更多选项"))}" aria-haspopup="dialog" aria-controls="cx-mobile-menu" aria-expanded="false">${ico("more")}</button></div>
    </header>
    <div class="cx-log" id="cx-log" role="log" aria-label="${esc(t("任务消息"))}"><div id="cx-boot"></div><div id="cx-msgs"></div><div class="cx-activity" id="cx-activity" role="status" hidden><i></i><span></span></div></div>
    <div class="cx-dock">
      <div class="cx-approvals" id="cx-approvals"></div>
      <div class="cx-mobile-suggestions" id="cx-mobile-suggestions"></div>
      <div class="cx-composer">
        <button class="cx-add" data-act="mobile-tools" aria-label="${esc(t("任务工具"))}" aria-haspopup="dialog" aria-controls="cx-mobile-menu" aria-expanded="false">${ico("plus")}</button>
        <textarea id="cx-input" rows="2" placeholder="${esc(t("描述任务，或接着问一个问题…"))}" aria-label="${esc(t("任务内容"))}" autocomplete="off" spellcheck="false"></textarea>
        <div class="cx-composer-bar"><div class="cx-model-slot" id="cx-model-slot"><div class="cx-models" id="cx-models"></div></div>
          <button class="cx-send" data-act="send" id="cx-send" title="${esc(t("发送"))}" aria-label="${esc(t("发送"))}">${ico("arrow")}</button>
          <button class="cx-stop hidden" data-act="stop" id="cx-stop" title="${esc(t("停止"))}" aria-label="${esc(t("停止"))}"><span></span></button>
        </div>
      </div>
      <div class="cx-foot">
        <span id="cx-state"><i class="cx-dot idle"></i>未连接</span>
        <button class="cx-foot-cwd" data-act="choose-project" id="cx-cwd"></button><span class="cx-enter-hint">${esc(t("Enter 发送 · Shift Enter 换行"))}</span>
      </div>
    </div>
  </main>
  <aside class="cx-review" id="cx-review" aria-label="${esc(t("改动审阅"))}" hidden>
    <div class="cx-review-head"><b>${esc(t("改动审阅"))}</b><button class="cx-icon" data-act="review-refresh" aria-label="${esc(t("刷新"))}">${ico("refresh")}</button><button class="cx-icon" data-act="review" aria-label="${esc(t("关闭"))}">${ico("close")}</button></div>
    <div class="cx-review-scope">${esc(t("当前项目的工作区改动"))}</div>
    <div class="cx-review-files" id="cx-review-files"></div>
    <div class="cx-diff" id="cx-diff"></div>
    <button class="cx-git-open" data-act="git">${ico("branch")}${esc(t("在 Git 面板中提交"))}</button>
  </aside>
  <section class="cx-onboarding" id="cx-onboarding" aria-labelledby="cx-setup-title" hidden></section>
  <dialog class="cx-dialog cx-preferences" id="cx-preferences" aria-labelledby="cx-preferences-title">
    <div class="cx-dialog-head"><h2 id="cx-preferences-title">${esc(t("Codex 设置"))}</h2><button class="cx-icon" data-act="settings-close" aria-label="${esc(t("关闭"))}">${ico("close")}</button></div>
    <nav class="cx-pref-tabs" aria-label="${esc(t("设置"))}"><button data-act="settings-tab" data-tab="general">${esc(t("通用"))}</button><button data-act="settings-tab" data-tab="connection">${esc(t("模型连接"))}</button><button data-act="settings-tab" data-tab="extensions">${esc(t("技能与 MCP"))}</button><button data-act="settings-tab" data-tab="device">${esc(t("应用与设备设置"))}</button></nav>
    <div id="cx-preferences-body"></div>
    <div id="cx-device-settings" class="cx-device-settings" hidden></div>
  </dialog>
  <dialog class="cx-dialog" id="cx-project-dialog" aria-labelledby="cx-project-dialog-title">
    <form id="cx-project-form"><div class="cx-dialog-head"><h2 id="cx-project-dialog-title">${esc(t("选择项目"))}</h2><button type="button" class="cx-icon" data-act="dialog-close" aria-label="${esc(t("关闭"))}">${ico("close")}</button></div>
      <div id="cx-project-options" class="cx-project-options"></div>
      <label>${esc(t("项目名称"))}<input id="cx-project-input-name" maxlength="60" placeholder="${esc(t("例如：我的应用"))}"></label>
      <label>${esc(t("已有项目目录"))}<input id="cx-project-input-path" required placeholder="/…/workspace/my-app" autocomplete="off"></label>
      <p id="cx-project-error" class="cx-form-error" role="alert"></p>
      <button type="submit" class="cx-primary" id="cx-project-submit">${esc(t("添加并开始任务"))}</button>
    </form>
  </dialog>
  <dialog class="cx-dialog cx-mobile-sheet" id="cx-mobile-menu" aria-labelledby="cx-mobile-menu-title">
    <div class="cx-sheet-handle" aria-hidden="true"></div>
    <div class="cx-dialog-head"><h2 id="cx-mobile-menu-title"></h2><button class="cx-icon" data-act="mobile-menu-close" aria-label="${esc(t("关闭"))}">${ico("close")}</button></div>
    <div class="cx-menu-context"><b id="cx-menu-project"></b><span id="cx-menu-cwd"></span></div>
    <div id="cx-compose-tools">
      <div class="cx-menu-grid"><button data-act="choose-project">${ico("folder")}<span>${esc(t("选择项目"))}</span></button><button data-act="files">${ico("folder")}<span>${esc(t("文件浏览器"))}</span></button><button data-act="terminal">${ico("terminal")}<span>${esc(t("终端"))}</span></button></div>
      <div class="cx-menu-model-heading">${esc(t("模型与思考强度"))}</div><div id="cx-menu-models"></div>
    </div>
    <div class="cx-menu-list" id="cx-task-actions" hidden>
      <button data-act="review">${ico("diff")}<span>${esc(t("改动审阅"))}</span><b id="cx-menu-change-count">0</b></button>
      <button data-act="git">${ico("branch")}<span>${esc(t("在 Git 面板中提交"))}</span></button>
      <button data-act="extensions">${ico("plus")}<span>${esc(t("技能与 MCP"))}</span></button>
      <button data-act="settings">${ico("settings")}<span>${esc(t("设置"))}</span></button>
    </div>
  </dialog>
</div>`;
    dom = {
      acct: $("cx-acct"), threads: $("cx-threads"), head: $("cx-head"),
      log: $("cx-log"), boot: $("cx-boot"), msgs: $("cx-msgs"),
      apprs: $("cx-approvals"), input: $("cx-input"), send: $("cx-send"), stop: $("cx-stop"),
      state: $("cx-state"), cwd: $("cx-cwd"),
      workbench: $("cx-workbench"), title: $("cx-title"), project: $("cx-project-name"), models: $("cx-models"),
      review: $("cx-review"), files: $("cx-review-files"), diff: $("cx-diff"), dialog: $("cx-project-dialog"),
      setup: $("cx-onboarding"),
      preferences: $("cx-preferences"),
      mobileMenu: $("cx-mobile-menu"), activity: $("cx-activity"),
    };
    root.addEventListener("click", onClick);
    new MutationObserver(() => window.CCLayout?.apply()).observe(root, { subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && dom.preferences.open && st.settingsTab === "general") loadNotifySettings();
    });
    dom.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    dom.input.addEventListener("input", () => { saveDraft(); resizeInput(); });
    dom.mobileMenu.addEventListener("close", () => {
      root.querySelectorAll('[aria-controls="cx-mobile-menu"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
    });
    dom.mobileMenu.addEventListener("click", (e) => { if (e.target === dom.mobileMenu) { const r = dom.mobileMenu.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dom.mobileMenu.close(); } });
    $("cx-search").addEventListener("input", (e) => { st.query = e.target.value; paintThreads(); });
    $("cx-project-form").addEventListener("submit", addProject);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && back()) e.preventDefault();
    });
    window.addEventListener("keydown", (e) => {
      if (!st.open || !(e.ctrlKey || e.metaKey) || e.altKey || dom.dialog.open || dom.preferences.open || dom.mobileMenu.open) return;
      if (e.key.toLowerCase() === "j") { e.preventDefault(); newThread(); }
      if (e.key === "`") { e.preventDefault(); openTool("terminal"); }
    });
    matchMedia("(max-width:760px)").addEventListener("change", () => {
      if (!st.open) return;
      syncMobileLayout();
      dom.workbench.classList.remove("side-collapsed"); toggleSidebar(false);
      dom.workbench.querySelector(".cx-main").inert = st.review && matchMedia("(max-width:760px)").matches;
    });
    syncMobileLayout();
    window.addEventListener("resize", () => { if (st.open) resizeInput(); });
    dom.log.addEventListener("click", (e) => {
      const b = e.target.closest(".copy-btn");
      if (b) { const pre = b.parentElement && b.parentElement.querySelector("code"); if (pre) { copyText(pre.textContent || ""); toast("已复制"); } }
    });
    return dom;
  }

  function onClick(e) {
    if (e.target.closest("#cx-device-settings")) return;
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "mobile-tools" || act === "mobile-more") return openMobileMenu(act === "mobile-tools");
    if (act === "mobile-menu-close") return dom.mobileMenu.close();
    if (el.closest("#cx-mobile-menu") && dom.mobileMenu.open) dom.mobileMenu.close();
    if (act === "sidebar") return toggleSidebar();
    if (act === "sidebar-close") return toggleSidebar(false);
    if (act === "app-menu" || act === "settings") return openSettings();
    if (act === "extensions") return openSettings("extensions");
    if (act === "settings-close") return dom.preferences.close();
    if (act === "settings-tab") { st.settingsTab = el.dataset.tab; paintSettings(); if (st.settingsTab === "extensions") loadExtensions(); return; }
    if (act === "extensions-refresh") return loadExtensions();
    if (act === "skill-toggle") return toggleSkill(el);
    if (act === "extension-files") { dom.preferences.close(); return CC.openFiles?.(el.dataset.dir); }
    if (act === "device-settings") return openSettings("device");
    if (act === "notify-settings") return post("/api/app/notify_settings").catch((e) => toast(e.message, true));
    if (act === "add-project" || act === "choose-project") return chooseProject();
    if (act === "dialog-close") return dom.dialog.close();
    if (act === "project") { dom.dialog.close(); return newThread(el.dataset.cwd); }
    if (act === "collapse-project") { st.collapsed.has(el.dataset.cwd) ? st.collapsed.delete(el.dataset.cwd) : st.collapsed.add(el.dataset.cwd); return paintThreads(); }
    if (act === "pin-thread") {
      st.pins = st.pins.includes(el.dataset.id) ? st.pins.filter((id) => id !== el.dataset.id) : [...st.pins, el.dataset.id];
      LS.set("pins", JSON.stringify(st.pins)); return paintThreads();
    }
    if (act === "review") return toggleReview();
    if (act === "review-refresh") return loadReview();
    if (act === "diff-file") return loadDiff(el.dataset.file);
    if (["files", "terminal", "git"].includes(act)) return openTool(act);
    if (act === "suggest") { dom.input.value = el.dataset.prompt; saveDraft(); resizeInput(); return dom.input.focus(); }
    if (act === "new") return newThread();
    if (act === "send") return send();
    if (act === "stop") return interrupt();
    if (act === "install") return install();
    if (act === "login") return login();
    if (act === "connection") return openSettings("connection");
    if (act === "switch-chat") {
      return saveConnectionConfig({ ...st.status.connection, wireApi: "chat" }).then(() => {
        toast(t("已切换 Chat Completions，请新建任务重试。"));
      }).catch((e) => toast(e.message, true));
    }
    if (act === "connection-chatgpt") return useChatGPT();
    if (act === "setup-skip") return skipLogin();
    if (act === "logout") return logout();
    if (act === "login-open") return openLoginUrl();
    if (act === "login-copy") { if (st.login) { copyText(st.login.userCode || ""); toast("登录码已复制"); } return; }
    if (act === "login-cancel") return cancelLogin();
    if (act === "setup-refresh") return checkLogin();
    if (act === "setup-project") return newThread(el.dataset.cwd || currentCwd());
    if (act === "setup-resume") return completeSetup();
    if (act === "open-thread") return openThread(el.dataset.id);
    if (act === "approve") return approve(el.dataset.id, el.dataset.decision, el.closest(".cx-appr"));
    if (act === "approve-input") return approveInput(el.dataset.id, el.closest(".cx-appr"));
    if (act === "refresh") return refresh();
    if (act === "retry") return refresh();
  }

  function saveDraft() { if (dom) LS.set("draft." + (st.threadId || "new"), dom.input.value); }
  function resizeInput() {
    dom.input.style.height = "auto";
    const limit = matchMedia("(max-width:760px)").matches ? Math.min(180, Math.max(80, innerHeight * .3)) : 180;
    dom.input.style.height = Math.min(limit, dom.input.scrollHeight) + "px";
    dom.workbench.classList.toggle("has-draft", !!dom.input.value.trim());
    dom.send.disabled = !st.status?.installed || st.busy || st.switching || st.connectionBusy || !dom.input.value.trim();
  }
  function syncMobileLayout() {
    const narrow = matchMedia("(max-width:760px)").matches;
    if (dom.mobileMenu.open) dom.mobileMenu.close();
    (narrow ? $("cx-menu-models") : $("cx-model-slot")).appendChild(dom.models);
    dom.input.rows = narrow ? 1 : 2;
    dom.input.placeholder = t(narrow ? "询问 Codex" : "描述任务，或接着问一个问题…");
    resizeInput();
  }
  function openMobileMenu(compose) {
    if (!matchMedia("(max-width:760px)").matches) return;
    $("cx-mobile-menu-title").textContent = t(compose ? "任务工具" : "更多选项");
    $("cx-compose-tools").hidden = !compose; $("cx-task-actions").hidden = compose;
    $("cx-menu-project").textContent = leaf(currentCwd()); $("cx-menu-cwd").textContent = currentCwd();
    $("cx-menu-change-count").textContent = $("cx-change-count").textContent;
    dom.mobileMenu.querySelectorAll('[data-act="files"],[data-act="terminal"],[data-act="git"],[data-act="review"]').forEach((b) => { b.disabled = !currentCwd(); });
    root.querySelectorAll('[aria-controls="cx-mobile-menu"]').forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.act === (compose ? "mobile-tools" : "mobile-more"))));
    dom.mobileMenu.showModal();
  }
  function restoreDraft() { dom.input.value = LS.get("draft." + (st.threadId || "new"), ""); resizeInput(); }
  function currentCwd() { return st.thread?.cwd || st.cwd || st.status?.cwd || ""; }
  function projectList() {
    const dirs = new Map();
    for (const p of st.projects) if (p.path) dirs.set(p.path, { path: p.path, name: p.name || leaf(p.path) });
    for (const th of st.threads || []) if (th.cwd && !dirs.has(th.cwd)) dirs.set(th.cwd, { path: th.cwd, name: leaf(th.cwd) });
    const cwd = currentCwd();
    if (cwd && !dirs.has(cwd)) dirs.set(cwd, { path: cwd, name: leaf(cwd) });
    return [...dirs.values()];
  }
  function projectFor(cwd) {
    return projectList().filter((p) => cwd === p.path || cwd.startsWith(p.path.replace(/\/$/, "") + "/")).sort((a, b) => b.path.length - a.path.length)[0];
  }
  function toggleSidebar(force) {
    const narrow = matchMedia("(max-width:760px)").matches;
    const fromSide = !!document.activeElement?.closest(".cx-side");
    if (narrow) st.sidebar = force == null ? !st.sidebar : force;
    else { st.sidebar = false; if (force == null) dom.workbench.classList.toggle("side-collapsed"); }
    dom.workbench.classList.toggle("side-open", st.sidebar);
    dom.workbench.querySelector(".cx-side").inert = narrow ? !st.sidebar : dom.workbench.classList.contains("side-collapsed");
    dom.workbench.querySelector(".cx-main").inert = narrow && (st.sidebar || st.review);
    dom.workbench.querySelector(".cx-sidebar-toggle").setAttribute("aria-expanded", String(narrow ? st.sidebar : !dom.workbench.classList.contains("side-collapsed")));
    if (narrow && st.sidebar) dom.workbench.querySelector('.cx-side [data-act="sidebar"]').focus();
    else if (narrow && fromSide) dom.workbench.querySelector(".cx-sidebar-toggle").focus();
  }
  function openTool(kind) {
    const cwd = currentCwd(), fn = kind === "terminal" ? CC.openTerm : kind === "git" ? CC.openGit : CC.openFiles;
    if (!cwd || !fn) return toast(t("当前工具不可用"), true);
    Promise.resolve(fn(kind === "terminal" ? { cwd } : cwd)).catch((e) => toast(e.message, true));
  }
  function chooseProject() {
    const projects = projectList();
    $("cx-project-options").innerHTML = projects.map((p) => `<button type="button" data-act="project" data-cwd="${esc(p.path)}">${ico("folder")}<span><b>${esc(p.name)}</b><small>${esc(p.path)}</small></span>${ico("chevron")}</button>`).join("");
    $("cx-project-input-name").value = ""; $("cx-project-input-path").value = "";
    $("cx-project-error").textContent = "";
    dom.dialog.showModal();
    if (!projects.length) $("cx-project-input-path").focus();
  }
  async function addProject(e) {
    e.preventDefault();
    const path = $("cx-project-input-path").value.trim(), name = $("cx-project-input-name").value.trim() || leaf(path);
    const btn = $("cx-project-submit"); btn.disabled = true;
    try {
      const r = await post("/api/projects", { name, path, mode: "dir" });
      if (!r.ok || !r.project) throw new Error(r.message || r.error || t("添加项目失败"));
      st.projects.push(r.project); paintThreads(); dom.dialog.close();
      await newThread(r.project.path);
    } catch (err) { $("cx-project-error").textContent = err.message; }
    finally { btn.disabled = false; }
  }
  async function loadProjects() {
    try { const r = await api("/api/projects"); st.projects = r.projects || []; paintThreads(); }
    catch (e) { console.warn("[codex] projects", e.message); }
  }
  function syncStatus(s) {
    st.status = s;
    if (!st.settingsBusy) {
      if (typeof s.model === "string") st.model = s.model;
      if (typeof s.effort === "string") st.effort = s.effort;
    }
    if (s.account) st.login = null;
    st.running = new Map((s.runningTurns || []).map((r) => [r.threadId, r.turn]));
    st.approvals = new Map((s.approvals || []).map((a) => [String(a.id), { method: a.method, params: a.params }]));
  }
  function toggleReview(force) {
    st.review = force == null ? !st.review : force;
    dom.workbench.classList.toggle("review-open", st.review); dom.review.hidden = !st.review;
    $("cx-review-toggle").setAttribute("aria-expanded", String(st.review));
    if (matchMedia("(max-width:760px)").matches) {
      dom.workbench.querySelector(".cx-main").inert = st.review;
      dom.workbench.querySelector(".cx-side").inert = st.review || !st.sidebar;
    }
    if (st.review) { loadReview(); dom.review.querySelector("button").focus(); }
    else (matchMedia("(max-width:760px)").matches ? dom.workbench.querySelector('[data-act="mobile-more"]') : $("cx-review-toggle")).focus();
  }
  async function loadReview() {
    const cwd = currentCwd(), seq = ++st.gitSeq;
    if (!cwd) return;
    st.gitBusy = true; st.gitError = ""; paintReview();
    try {
      const r = await api("/api/git/status?" + new URLSearchParams({ dir: cwd }));
      if (seq !== st.gitSeq || cwd !== currentCwd()) return;
      if (r.error && !r.notRepo) throw new Error(r.error);
      st.git = r;
      if (st.review && r.files?.length) await loadDiff(r.files.some((f) => f.path === st.diffFile) ? st.diffFile : r.files[0].path);
      else { st.diff = ""; st.diffFile = ""; }
    } catch (e) { if (seq === st.gitSeq) { st.git = null; st.gitError = e.message; } }
    finally { if (seq === st.gitSeq) { st.gitBusy = false; paintReview(); } }
  }
  async function loadDiff(file) {
    const cwd = currentCwd(), seq = ++st.diffSeq;
    st.diffFile = file; st.diff = ""; st.diffBusy = true; paintReview();
    try {
      const r = await api("/api/git/diff?" + new URLSearchParams({ dir: cwd, file }));
      if (seq !== st.diffSeq || cwd !== currentCwd()) return;
      st.diff = r.diff || t("没有可显示的文本改动");
      if (r.truncated) st.diff += "\n" + t("内容过长，仅显示部分改动");
    } catch (e) { if (seq === st.diffSeq) st.diff = e.message; }
    finally { if (seq === st.diffSeq) { st.diffBusy = false; paintReview(); } }
  }
  function paintReview() {
    if (!dom) return;
    const files = st.git?.files || [];
    $("cx-change-count").textContent = files.length + (st.git?.truncated ? "+" : "");
    $("cx-branch").innerHTML = st.git?.branch ? ico("branch") + `<span>${esc(st.git.branch)}</span>` : "";
    dom.files.innerHTML = st.gitError ? `<p class="cx-panel-empty">${esc(st.gitError)}</p>`
      : st.gitBusy && !st.git ? `<p class="cx-panel-empty">${esc(t("读取中…"))}</p>`
      : st.git?.notRepo ? `<p class="cx-panel-empty">${esc(t("当前目录不是 Git 仓库"))}</p>`
      : !files.length ? `<div class="cx-panel-empty">${ico("diff")}<b>${esc(t("工作区没有改动"))}</b><span>${esc(t("文件修改后会显示在这里"))}</span></div>`
      : files.map((f) => `<button class="cx-review-file${f.path === st.diffFile ? " on" : ""}" data-act="diff-file" data-file="${esc(f.path)}"><span class="cx-file-kind">${esc(({ new: "U", added: "A", deleted: "D", renamed: "R", conflict: "!" })[f.kind] || "M")}</span><span title="${esc(f.path)}">${esc(f.path)}</span><small><i>+${Number(f.add) || 0}</i> <em>−${Number(f.del) || 0}</em></small></button>`).join("");
    dom.diff.innerHTML = st.diffBusy ? `<p class="cx-panel-empty">${esc(t("读取中…"))}</p>` : !st.diffFile ? ""
      : `<div class="cx-diff-name">${esc(st.diffFile)}</div><pre>${st.diff.split("\n").map((line) => `<span class="${line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}">${esc(line)}\n</span>`).join("")}</pre>`;
  }

  // ── 状态 / 绘制 ─────────────────────────────────────────────────────
  function connected(s = st.status) { return s?.connection?.mode === "custom" ? !!s.connection.configured : !!s?.account; }
  function setState(text, kind = "") {
    if (!dom) return;
    dom.state.dataset.kind = kind;
    dom.state.innerHTML = `<i class="cx-dot ${kind}"></i>${esc(text)}`;
  }

  function paint() {
    const s = st.status || {};
    const acc = s.account || null;
    const install = s.install || {};
    const installed = !!s.installed || install.state === "done";
    const server = !!s.server;
    const turn = st.running.get(st.threadId);

    // 账户
    if (dom) {
      if (s.connection?.mode === "custom") {
        dom.acct.innerHTML = `<span class="cx-avatar">A</span><button class="cx-login-link" data-act="connection"><b>${esc(t("自定义 API"))}</b><small>${esc(s.connection.model || t("未配置"))}</small></button>`;
      } else if (acc) {
        const who = acc.email || (acc.type === "apiKey" ? "API Key" : "已登录");
        dom.acct.innerHTML = `<span class="cx-avatar">${esc(who[0].toUpperCase())}</span><span><b>${esc(who)}</b><small>${esc(acc.planType || "ChatGPT")}</small></span><button data-act="logout" title="${esc(t("退出登录"))}" aria-label="${esc(t("退出登录"))}">${ico("close")}</button>`;
      } else {
        dom.acct.innerHTML = `<span class="cx-avatar">C</span><button class="cx-login-link" data-act="connection"><b>${esc(t("连接模型"))}</b><small>${esc(t("ChatGPT 或自定义 API"))}</small></button>`;
      }
    }

    // 顶栏
    if (dom) {
      const name = st.thread && (st.thread.name || st.thread.preview) ? (st.thread.name || st.thread.preview) : t(st.threadId ? "已恢复的任务" : "新任务");
      const models = (s.models || []).filter((m) => !m.hidden);
      const cur = models.find((m) => m.id === st.model) || models.find((m) => m.isDefault) || models[0];
      dom.workbench.querySelector(".cx-mobile-model span").textContent = cur?.displayName || st.model || "Codex";
      const efforts = cur && cur.supportedReasoningEfforts ? cur.supportedReasoningEfforts : [];
      dom.title.textContent = name;
      dom.project.textContent = leaf(currentCwd()); dom.project.title = currentCwd();
      dom.models.innerHTML = (models.length ? `<label class="cx-chip"><select id="cx-model" aria-label="${esc(t("模型"))}"><option value="">${esc(t("默认模型"))}</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === st.model ? " selected" : ""}>${esc(m.displayName || m.id)}</option>`).join("")}</select></label>` : `<span class="cx-chip">Codex</span>`)
        + (efforts.length ? `<label class="cx-chip"><select id="cx-effort" aria-label="${esc(t("思考强度"))}"><option value="">${esc(t("默认"))}</option>${efforts.map((x) => `<option value="${esc(x.reasoningEffort)}"${x.reasoningEffort === st.effort ? " selected" : ""}>${esc(x.reasoningEffort)}</option>`).join("")}</select></label>` : "");
      const msel = $("cx-model"), esel = $("cx-effort");
      if (msel) { msel.disabled = st.settingsBusy; msel.addEventListener("change", () => saveSettings(msel.value, "")); }
      if (esel) { esel.disabled = st.settingsBusy; esel.addEventListener("change", () => saveSettings(st.model, esel.value)); }
    }

    // 线程列表
    paintThreads();

    // 状态行
    if (dom) {
      if (!installed) setState(t("Codex 引擎未安装"), "err");
      else if (install.state === "installing") setState(t("安装中") + ` ${install.total ? Math.round((install.done || 0) / install.total * 100) + "%" : ""}`, "busy");
      else if (turn) setState(t("Codex 正在运行…"), "busy");
      else if (server) setState(t(connected(s) ? "就绪" : "尚未连接模型"), connected(s) ? "" : "idle");
      else setState(t("引擎未启动"), "idle");
      dom.send.disabled = !installed || st.busy || st.switching || st.connectionBusy || !dom.input.value.trim();
      dom.input.disabled = st.switching;
      dom.stop.classList.toggle("hidden", !turn);
      dom.send.classList.toggle("hidden", !!turn);
      dom.cwd.textContent = leaf(currentCwd());
      dom.cwd.title = currentCwd();
    }
    paintBoot();
    paintApprovals();
    paintSetup();
    paintActivity();
  }

  function completeSetup() {
    if (!st.status?.installed || (!connected() && !st.skipLogin)) return;
    st.onboarded = true; st.setupSession = false; LS.set("onboarded", "1");
    paint(); dom.input.focus();
  }

  function paintSetup() {
    if (!dom || !st.status) return;
    const s = st.status, install = s.install || {}, installed = !!s.installed || install.state === "done";
    const firstProject = !st.onboarded && st.threadsLoaded && !st.threadId && !st.threads?.length;
    const ready = connected(s) || st.skipLogin;
    if (!installed || !ready) st.setupSession = true;
    if (installed && ready && (st.onboarded || st.threadId || st.threads?.length)) st.setupSession = false;
    const active = !installed || !ready || firstProject || st.setupSession;
    const narrow = matchMedia("(max-width:760px)").matches;
    dom.setup.hidden = !active;
    dom.workbench.classList.toggle("onboarding-active", active);
    if (active && dom.mobileMenu.open) dom.mobileMenu.close();
    dom.workbench.querySelector(".cx-main").inert = active || (narrow && (st.sidebar || st.review));
    dom.workbench.querySelector(".cx-side").inert = active || (narrow ? !st.sidebar : dom.workbench.classList.contains("side-collapsed"));
    if (!active) {
      st.setupStep = 0;
      if (!st.nativeSetupSaved) { try { if (window.CCApp?.setupDone) { CCApp.setupDone(); st.nativeSetupSaved = true; } } catch {} }
      return;
    }
    const step = !installed ? 1 : !ready ? 2 : 3;
    const working = !!st.setupBusy || install.state === "installing";
    const error = st.setupError || install.error || s.lastError || "";
    const button = (act, label, secondary = false, attrs = "") => `<button class="cx-setup-${secondary ? "secondary" : "primary"}" data-act="${act}"${working ? " disabled" : ""}${attrs}>${esc(t(label))}${secondary ? "" : ico("chevron")}</button>`;
    let title, description, body;
    if (step === 1) {
      title = t("把想法，变成作品。");
      description = t("让 Codex 理解你的项目，编写代码，并和你一起完成验证。");
      const percent = install.total ? Math.max(0, Math.min(100, Math.round((install.done || 0) / install.total * 100))) : 0;
      body = `<div class="cx-setup-package">${ico("terminal")}<span><b>${esc(t("安装 Codex"))}</b><small>${esc(t("只需安装一次，约 {size}", { size: fmtSize(88007340) }))}</small></span><span class="cx-setup-tag">${esc(t("本机运行"))}</span></div>
        ${install.state === "installing" ? `<div class="cx-setup-progress" role="progressbar" aria-label="${esc(t("安装进度"))}"${install.total ? ` aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"` : ""}><i style="width:${percent}%"></i></div><p class="cx-setup-status" role="status">${esc(install.phase || t("正在准备下载…"))}${install.total ? ` · ${percent}% · ${esc(fmtSize(install.done))} / ${esc(fmtSize(install.total))}` : ""}</p>` : ""}
        ${button("install", working ? "正在安装…" : error ? "重试安装" : "安装并继续")}
        <p class="cx-setup-note">${esc(t("下载中断后可以继续，完成后会自动进入下一步。"))}</p>`;
    } else if (step === 2) {
      title = t("选择你的模型连接方式");
      description = t("使用 ChatGPT、自定义第三方 API，或稍后再连接。coxdragon 是独立客户端，非 OpenAI 官方应用。");
      body = st.login ? `<div class="cx-setup-auth"><span>${esc(t("一次性登录代码"))}</span>${st.login.userCode ? `<button class="cx-setup-code" data-act="login-copy" aria-label="${esc(t("复制代码"))}">${esc(st.login.userCode)}<small>${esc(t("点击复制"))}</small></button>` : ""}<p>${esc(t("打开授权页面，输入代码并确认登录。"))}</p></div>
        ${button("login-open", "打开浏览器继续")}${button("setup-refresh", st.setupBusy === "refresh" ? "正在检查…" : "我已完成授权", true)}
        <button class="cx-setup-link" data-act="login-cancel"${working ? " disabled" : ""}>${esc(t("取消并重新登录"))}</button>`
        : `${button("login", st.setupBusy === "login" ? "正在连接…" : "使用 ChatGPT 登录")}${button("connection", "自定义第三方 API", true)}<p class="cx-setup-note">${esc(t("ChatGPT 授权在官方网页完成；第三方 API 使用你自己的地址和密钥。"))}</p>`;
      body += `<button class="cx-setup-link" data-act="setup-skip"${working ? " disabled" : ""}>${esc(t("跳过，先进入工作台"))}</button>`;
    } else {
      title = t("从一个项目开始");
      description = t("选择工作目录，Codex 的文件、终端和改动审阅都会跟随这个项目。");
      const cwd = currentCwd(), projects = projectList();
      body = `<div class="cx-setup-ready">${ico("plus")}<span>${esc(t(connected(s) ? "环境已就绪，模型已连接" : "环境已就绪，可稍后连接模型"))}</span></div>
        <div class="cx-setup-projects">${projects.slice(0, 4).map((p) => `<button data-act="setup-project" data-cwd="${esc(p.path)}"${st.switching ? " disabled" : ""}>${ico("folder")}<span><b>${esc(p.name)}</b><small>${esc(p.path)}</small></span>${ico("chevron")}</button>`).join("")}</div>
        ${cwd ? button("setup-project", st.switching ? "正在打开项目…" : "使用当前工作区", false, st.switching ? " disabled" : "") : ""}
        ${button("choose-project", "选择其他项目目录", true)}
        ${st.threads?.length ? `<button class="cx-setup-link" data-act="setup-resume">${esc(t("继续已有任务"))}</button>` : ""}
        <p class="cx-setup-note">${esc(t("你可以随时添加更多项目。现在不会自动发送任务。"))}</p>`;
    }
    const labels = [t("准备环境"), t("连接模型"), t("开始任务")];
    const html = `<header class="cx-setup-top"><span class="cx-setup-brand"><span class="cx-mark">c<span>›</span></span>coxdragon</span><button class="cx-icon" data-act="settings" aria-label="${esc(t("设置"))}">${ico("settings")}</button></header>
      <div class="cx-setup-layout"><div class="cx-setup-content"><ol class="cx-setup-steps" aria-label="${esc(t("工作台设置"))}">${labels.map((l, i) => `<li class="${i + 1 < step ? "done" : i + 1 === step ? "current" : ""}"${i + 1 === step ? ' aria-current="step"' : ""}><span>${i + 1 < step ? "✓" : "0" + (i + 1)}</span>${esc(l)}</li>`).join("")}</ol>
        <div class="cx-setup-kicker">${esc(t("你的移动开发工作台"))}</div><h1 id="cx-setup-title" tabindex="-1">${esc(title)}</h1><p class="cx-setup-description">${esc(description)}</p>${body}
        ${error ? `<div class="cx-setup-error" role="alert"><b>${esc(t("这一步没有完成"))}</b><p>${esc(error)}</p><span>${esc(t("已完成的步骤会保留，可以在这里重试。"))}</span></div>` : ""}</div>
      <aside class="cx-setup-preview" aria-hidden="true"><div class="cx-setup-preview-caption">${esc(t("想法，从这里开始。"))}</div><div class="cx-setup-window"><div class="cx-setup-window-head"><i></i><i></i><i></i><span>coxdragon</span></div><div class="cx-setup-window-body"><span class="cx-setup-project-label">${ico("folder")} my-project</span><div class="cx-setup-bubble">${esc(t("给这个项目加一个搜索功能"))}</div><div class="cx-setup-answer"><span class="cx-mark">c<span>›</span></span><p>${esc(t("先理解项目，再实现并验证。"))}</p></div><ul><li>✓ ${esc(t("梳理项目结构"))}</li><li>✓ ${esc(t("实现搜索功能"))}</li><li class="cx-setup-preview-last">${ico("diff")} ${esc(t("一起审阅改动"))}</li></ul><div class="cx-setup-preview-input">${esc(t("继续描述你的想法…"))}<span>↑</span></div></div></div><p>${esc(t("项目、对话、终端与改动，都在一个工作台里。"))}</p></aside></div>
      <footer class="cx-setup-footer">${esc(t("独立客户端 · 非 OpenAI 官方应用"))}</footer>`;
    if (dom.setup.innerHTML !== html) {
      const action = dom.setup.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      dom.setup.innerHTML = html;
      if (st.setupStep !== step) { st.setupStep = step; $("cx-setup-title").focus({ preventScroll: true }); }
      else if (action) dom.setup.querySelector(`[data-act="${action}"]`)?.focus({ preventScroll: true });
    }
  }

  async function checkLogin() {
    if (st.setupBusy) return;
    st.setupBusy = "refresh"; st.setupError = ""; paintSetup();
    try { syncStatus(await post("/api/codex/refresh")); if (!st.status.account) st.setupError = t("还没有收到授权结果，完成浏览器中的确认后再试。每次只需登录一次。"); }
    catch (e) { st.setupError = e.message; }
    finally { st.setupBusy = ""; paint(); }
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
    const empty = installed && !st.items.size && !dom.msgs.querySelector(".cx-appr");
    dom.workbench.classList.toggle("has-messages", !empty);
    const mobilePrompts = [t("介绍这个项目的架构"), t("检查当前改动中的问题")];
    const mobileSuggestions = mobilePrompts.map((p, i) => `<button data-act="suggest" data-prompt="${esc(p)}">${ico(i ? "diff" : "folder")}<span>${esc(p)}</span></button>`).join("");
    if ($("cx-mobile-suggestions").innerHTML !== mobileSuggestions) $("cx-mobile-suggestions").innerHTML = mobileSuggestions;
    if (empty) {
      const prompts = [t("介绍这个项目的架构"), t("检查当前改动中的问题"), t("帮我实现一个新功能")];
      dom.msgs.innerHTML = `<div class="cx-empty"><span class="cx-welcome-mark">c<span>›</span></span><h1>${esc(t("准备好构建什么？"))}</h1><p>${esc(connected() ? t("从一个想法开始，在项目里把它变成现实。") : t("连接 ChatGPT 或自定义 API 后即可发送任务。"))}</p><div class="cx-suggestions">${prompts.map((p, i) => `<button data-act="suggest" data-prompt="${esc(p)}">${ico(["folder", "diff", "plus"][i])}<span>${esc(p)}</span>${ico("chevron")}</button>`).join("")}</div></div>`;
    } else if (dom.msgs.firstElementChild?.classList.contains("cx-empty")) dom.msgs.firstElementChild.remove();
  }

  function paintThreads() {
    if (!dom) return;
    const query = st.query.trim().toLocaleLowerCase();
    const threads = (st.threads || []).filter((th) => !query || `${th.name || ""} ${th.preview || ""} ${th.cwd || ""}`.toLocaleLowerCase().includes(query));
    const row = (th) => `<div class="cx-thread-row${th.id === st.threadId ? " on" : ""}"><button class="cx-th" data-act="open-thread" data-id="${esc(th.id)}"${st.switching ? " disabled" : ""}><span class="cx-thread-dot${st.running.has(th.id) ? " running" : ""}"></span><b>${esc(th.name || th.preview || t("未命名任务"))}</b><small>${esc(th.updatedAt ? relTime(th.updatedAt * 1000) : "")}</small></button><button class="cx-pin${st.pins.includes(th.id) ? " on" : ""}" data-act="pin-thread" data-id="${esc(th.id)}" aria-label="${esc(t(st.pins.includes(th.id) ? "取消固定" : "固定任务"))}" aria-pressed="${st.pins.includes(th.id)}">${ico("pin")}</button></div>`;
    let h = "";
    const pinned = threads.filter((th) => st.pins.includes(th.id));
    if (pinned.length) h += `<div class="cx-group-title">${esc(t("已固定"))}</div>` + pinned.map(row).join("");
    for (const p of projectList()) {
      const mine = threads.filter((th) => !st.pins.includes(th.id) && projectFor(th.cwd || "")?.path === p.path);
      if (query && !mine.length) continue;
      const collapsed = !query && st.collapsed.has(p.path);
      h += `<section class="cx-project-group"><div class="cx-project-row"><button class="cx-project-toggle${collapsed ? " collapsed" : ""}" data-act="collapse-project" data-cwd="${esc(p.path)}" aria-expanded="${!collapsed}">${ico("chevron")}${ico("folder")}<span title="${esc(p.path)}">${esc(p.name)}</span></button><button class="cx-icon" data-act="project" data-cwd="${esc(p.path)}" aria-label="${esc(t("新任务"))}">${ico("plus")}</button></div>${collapsed ? "" : mine.map(row).join("") || `<div class="cx-project-empty">${esc(t("还没有任务"))}</div>`}</section>`;
    }
    const other = threads.filter((th) => !th.cwd && !st.pins.includes(th.id));
    if (other.length) h += `<div class="cx-group-title">${esc(t("其他任务"))}</div>` + other.map(row).join("");
    dom.threads.innerHTML = h || `<div class="cx-panel-empty">${esc(t(query ? "没有匹配的任务" : "添加一个项目，开始工作"))}</div>`;
  }

  // ── 审批 / 登录卡 ───────────────────────────────────────────────────
  function paintApprovals() {
    if (!dom) return;
    let h = "";
    if (st.login && dom.setup.hidden) {
      const L = st.login;
      h += `<div class="cx-login"><b>登录 ChatGPT</b><br>在浏览器打开下方地址，输入一次性代码：<br>
        <span class="tiny mono">${esc(L.verificationUrl || "")}</span><br><code>${esc(L.userCode || "")}</code>
        <div class="cx-appr-acts"><button data-act="login-open">打开浏览器</button><button data-act="login-copy">复制代码</button><button data-act="login-cancel">取消</button></div>
        <div class="tiny" style="color:var(--fg3);margin-top:5px">登录完成后窗口会自动继续；不要把这个码发给任何人。</div></div>`;
    }
    for (const [id, p] of st.approvals) if (!p.params?.threadId || p.params.threadId === st.threadId) h += approvalHtml(id, p);
    if (dom.apprs.innerHTML !== h) dom.apprs.innerHTML = h;
    paintActivity();
  }

  // Show only activity established by the current turn's app-server events.
  function paintActivity() {
    if (!dom) return;
    const turn = st.running.get(st.threadId);
    dom.activity.hidden = !turn;
    if (!turn) return;
    const pending = [...st.approvals.values()].some((a) => !a.params?.threadId || a.params.threadId === st.threadId);
    const active = [...st.items.values()].reverse().find((it) => it.turnId === turn.id && !it.done && it.type !== "userMessage");
    const key = pending ? "等待你的确认" : ({ reasoning: "正在思考…", commandExecution: "正在执行命令…", fileChange: "正在修改文件…", mcpToolCall: "正在调用工具…", webSearch: "正在调用工具…", agentMessage: "正在回复…" })[active?.type] || "Codex 正在运行…";
    const label = t(key);
    if (dom.activity.lastElementChild.textContent !== label) dom.activity.lastElementChild.textContent = label;
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
    dom.workbench.classList.add("has-messages");
    const empty = dom.msgs.querySelector(".cx-empty");
    if (empty) empty.remove();
    dom.msgs.appendChild(d);
    return it;
  }

  function renderItem(item, turnId, done) {
    if (!dom || !item || !item.id) return;
    ensureDom();
    const it = getEntry(item, turnId);
    it.data = item;
    it.done = done ?? (item.status != null && item.status !== "inProgress");
    if (item.type === "agentMessage" && item.text != null) it.text = item.text;
    if (item.type === "reasoning") it.text = (item.summary || []).join("\n") || (item.content || []).join("\n") || it.text;
    if (item.type === "commandExecution" && item.aggregatedOutput != null) it.out = item.aggregatedOutput;
    paintItem(it);
    paintActivity();
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
        if (!d.firstChild) d.innerHTML = `<details><summary>${esc(t("思考摘要"))}</summary><div class="cx-think-body"></div></details>`;
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
      paintActivity();
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
    for (const it of st.items.values()) { if (it.raf) cancelAnimationFrame(it.raf); if (it.outRaf) cancelAnimationFrame(it.outRaf); }
    st.items.clear();
    st.errors.clear(); clearTimeout(st.threadErrorTimer);
    if (dom) dom.msgs.innerHTML = "";
  }

  function hydrateThread(t) {
    clearMessages();
    if (!t) return;
    const turns = Array.isArray(t.turns) ? t.turns : [];
    for (const turn of turns) {
      for (const item of (turn.items || [])) renderItem(item, turn.id, turn.status !== "inProgress" || (item.status != null && item.status !== "inProgress"));
      if (turn.error) addError(turn.error.message || "这一轮失败了", turn.id);
    }
    if (!turns.length) paintBoot();
  }

  // ── 事件 ───────────────────────────────────────────────────────────
  function connect() {
    if (st.es) return;
    let es;
    try { es = new EventSource("/api/codex/events"); } catch (e) { setState("事件流建不起来", "err"); return; }
    st.es = es;
    es.onopen = () => { if (st.open) { st.autoResumed = false; loadThreads(); } };
    es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (x) { console.warn("[codex] bad event", x); } };
    es.onerror = () => { setState("事件流断开，正在重连…", "err"); };
  }
  function disconnect() { if (st.es) { try { st.es.close(); } catch {} st.es = null; } }

  function handle(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === "settings") { st.model = ev.model; st.effort = ev.effort; paint(); return; }
    if (ev.type === "status") { syncStatus(ev.status); paint(); return; }
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
      if (ev.state === "exited" || ev.state === "stopped") { st.running.clear(); st.approvals.clear(); }
      paint();
      if (ev.state === "ready") refreshSoon();
      return;
    }
    if (ev.type === "thread") {
      refreshThreadsSoon();
      return;
    }
    if (ev.type === "turn") {
      if (ev.threadId && ev.turn?.status === "inProgress" && !st.endedTurns.has(ev.turn.id)) st.running.set(ev.threadId, ev.turn);
      if (ev.threadId && ev.turn?.status !== "inProgress") st.running.delete(ev.threadId);
      paint(); if (ev.threadId === st.threadId) scrollBottom(); return;
    }
    if (ev.type === "approval") { st.approvals.set(String(ev.id), { method: ev.method, params: ev.params }); paintApprovals(); scrollBottom(); return; }
    if (ev.type === "approval-done") { st.approvals.delete(String(ev.id)); paintApprovals(); return; }
    if (ev.type !== "rpc") return;
    const m = ev.method, p = ev.params || {};
    if (m === "turn/started" && p.threadId && p.turn) st.running.set(p.threadId, p.turn);
    if (m === "turn/completed" && p.threadId) {
      if (p.turn?.id) { st.endedTurns.add(p.turn.id); if (st.endedTurns.size > 200) st.endedTurns.delete(st.endedTurns.values().next().value); }
      if (!st.running.has(p.threadId) || !p.turn || st.running.get(p.threadId).id === p.turn.id) st.running.delete(p.threadId);
      refreshThreadsSoon();
    }
    if (p.threadId && p.threadId !== st.threadId) { paintThreads(); return; }
    switch (m) {
      case "item/started":
      case "item/completed":
        if (p.item) renderItem(p.item, p.turnId, m === "item/completed");
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
          addError(p.turn.error.message || "这一轮失败了", p.turn.id);
          st.lastWarn = p.turn.error.message || "";
        }
        paint(); refreshThreadsSoon(); loadReview();
        break;
      case "thread/started":
        refreshThreadsSoon();
        break;
      case "thread/status/changed":
        if (p.status?.type === "systemError") {
          clearTimeout(st.threadErrorTimer);
          const threadId = st.threadId, turnId = st.running.get(threadId)?.id || "";
          st.threadErrorTimer = setTimeout(() => {
            if (st.threadId === threadId && ![...st.errors.values()].some((e) => !turnId || e.turnId === turnId)) addError("线程出错，可以重新开始一个任务。", turnId, true);
          }, 500);
        }
        break;
      case "error":
        addError((p.error && p.error.message) || "Codex 报错", p.turnId || st.running.get(st.threadId)?.id || "");
        break;
      case "warning":
      case "configWarning":
        if (p.message && p.message !== st.lastWarn) { st.lastWarn = p.message; toast(p.message); }
        break;
      case "account/login/completed":
        if (p.loginId && st.login?.loginId && p.loginId !== st.login.loginId) break;
        if (p.success) { st.login = null; st.setupError = ""; toast(t("登录成功")); refreshSoon(); }
        else { st.login = null; st.setupError = p.error || t("登录未完成，请重新获取代码。"); if (dom.setup.hidden) toast(st.setupError, true); }
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
        if (p.requestId != null || p.id != null) { st.approvals.delete(String(p.requestId ?? p.id)); paintApprovals(); }
        break;
    }
  }

  function addError(msg, turnId = "", generic = false) {
    if (!dom || !msg) return;
    let detail; try { const parsed = JSON.parse(msg); detail = parsed.error || parsed; } catch {}
    const message = detail?.message || msg, requestId = detail?.requestId || "";
    const key = requestId ? "request:" + requestId : turnId + ":" + message;
    if (st.errors.has(key)) return;
    if (!generic) for (const [k, error] of st.errors) if (error.generic) { error.el.remove(); st.errors.delete(k); }
    const d = document.createElement("div");
    d.className = "cx-appr cx-error";
    const c = st.status?.connection, codeflowResponses = c?.mode === "custom" && c.wireApi === "responses" && /^https:\/\/codeflow\.sh(?:\/|$)/i.test(c.baseUrl || "") && (detail?.code === "upstream_error" || /upstream_error|Upstream service error/.test(msg));
    d.innerHTML = `<div class="cx-appr-h">出错了</div><div>${esc(message)}</div>${requestId ? `<p class="tiny">Request ID: ${esc(requestId)}</p>` : ""}${codeflowResponses ? `<p>${esc(t("CodeFlow 的 Responses 接口未完成任务，请改用 Chat Completions。"))}</p><button data-act="switch-chat">${esc(t("改用 Chat Completions"))}</button>` : ""}`;
    st.errors.set(key, { el: d, turnId, generic });
    const empty = dom.msgs.querySelector(".cx-empty"); if (empty) empty.remove();
    dom.msgs.appendChild(d);
    dom.workbench.classList.add("has-messages");
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
      syncStatus(s);
      st.installed = !!s.installed;
      if (!st.cwd) st.cwd = s.cwd || "";
      if (s.activeThread && !st.thread && !st.threadId) { st.threadId = s.activeThread.id; }
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
      st.threadsLoaded = true;
      if (st.status) st.status.threads = st.threads;
      paintThreads();
      paintSetup();
      if (!st.autoResumed && st.threadId && st.threads.some((t) => t.id === st.threadId)) { st.autoResumed = true; openThread(st.threadId); }
    } catch { /* 未安装 / 引擎没起来时不用报 */ }
  }

  async function install() {
    if (st.setupBusy || st.status?.install?.state === "installing") return;
    st.setupBusy = "install"; st.setupError = ""; paintSetup();
    try { await post("/api/codex/install"); refreshSoon(); }
    catch (e) { st.setupError = e.message; if (dom.setup.hidden) toast(e.message, true); }
    finally { st.setupBusy = ""; paint(); }
  }

  async function newThread(cwd) {
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    if (!connected() && !st.skipLogin) return paintSetup();
    if (st.connectionBusy) return;
    if (st.switching || st.busy) return;
    const dir = cwd || currentCwd();
    if (!dir) return chooseProject();
    saveDraft(); st.switching = true; st.autoResumed = true; paint();
    try {
      const r = await post("/api/codex/thread", { cwd: dir });
      clearMessages();
      st.thread = r.thread; st.threadId = r.thread && r.thread.id || "";
      if (st.threadId) LS.set("thread", st.threadId);
      st.cwd = (r.thread && r.thread.cwd) || dir || st.cwd;
      LS.set("cwd", st.cwd);
      restoreDraft(); resetReview(); toggleSidebar(false);
      paint(); loadThreads(); loadReview();
      if (!st.onboarded || !dom.setup.hidden) completeSetup();
      dom.input.focus();
      toast(t("新任务已开始"));
    } catch (e) { toast(e.message, true); }
    finally { st.switching = false; paint(); dom.input.focus(); }
  }

  async function openThread(id) {
    if (!id || st.switching || st.busy) return;
    saveDraft(); st.switching = true; const seq = ++st.viewSeq; paint();
    try {
      const r = await post("/api/codex/open-thread", { threadId: id });
      if (seq !== st.viewSeq) return;
      st.thread = r.thread; st.threadId = id; LS.set("thread", id);
      st.cwd = (r.thread && r.thread.cwd) || st.cwd;
      const running = (r.thread?.turns || []).find((turn) => turn.status === "inProgress" && !st.endedTurns.has(turn.id));
      if (running) st.running.set(id, running);
      hydrateThread(r.thread);
      restoreDraft(); resetReview(); toggleSidebar(false); loadReview();
      paint(); scrollBottom();
    } catch (e) { toast(e.message, true); }
    finally { if (seq === st.viewSeq) { st.switching = false; paint(); } }
  }

  function resetReview() { st.gitSeq++; st.diffSeq++; st.git = null; st.gitError = ""; st.diff = ""; st.diffFile = ""; st.diffBusy = false; paintReview(); }

  async function send() {
    if (!dom || st.busy || st.switching || st.connectionBusy || st.running.has(st.threadId)) return;
    const text = dom.input.value.trim();
    if (!text) return;
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    if (!connected()) { saveDraft(); openSettings("connection"); return toast(t("连接模型后即可发送，草稿已保留。")); }
    if (!st.threadId) {
      await newThread();
      if (!st.threadId) return;
      dom.input.value = text; saveDraft(); resizeInput();
    }
    st.busy = true; dom.send.disabled = true;
    const target = st.threadId;
    post("/api/codex/turn", { text, threadId: target }).then((r) => {
      // 回执到达前用户可能已经开始写下一条，不能把新输入连同草稿一起清掉。
      if (dom.input.value.trim() === text) dom.input.value = "";
      resizeInput(); saveDraft(); scrollBottom();
      if (r.turn?.status === "inProgress" && !st.endedTurns.has(r.turn.id)) st.running.set(target, r.turn);
      paint();
    }).catch((e) => {
      if (st.status) st.status.activeTurn = null;
      addError(e.message);
      toast(e.message, true);
      paint();
    }).finally(() => { st.busy = false; paint(); });
  }

  async function interrupt() {
    try { await post("/api/codex/interrupt", { threadId: st.threadId }); toast("已请求停止"); }
    catch (e) { toast(e.message, true); }
  }

  async function login() {
    if (!st.status || !st.status.installed) return toast("先安装 Codex 引擎", true);
    if (st.setupBusy || st.login) return;
    if (st.status.connection?.mode === "custom") return useChatGPT();
    if (dom.preferences.open) dom.preferences.close();
    st.setupBusy = "login"; st.setupError = ""; paintSetup();
    try {
      const r = await post("/api/codex/login");
      if (r && r.type === "chatgptDeviceCode") { st.login = r; }
      else if (r && r.type === "chatgpt" && r.authUrl) {
        st.login = { loginId: r.loginId, verificationUrl: r.authUrl, userCode: "" };
        paintApprovals(); openLoginUrl();
      } else toast("已发起登录，请稍候");
    } catch (e) { st.setupError = e.message; if (dom.setup.hidden) toast(e.message, true); }
    finally { st.setupBusy = ""; paint(); }
  }

  async function cancelLogin() {
    if (st.setupBusy) return;
    const l = st.login; st.setupBusy = "cancel"; st.setupError = ""; paintSetup();
    try { if (l?.loginId) await post("/api/codex/login-cancel", { loginId: l.loginId }); st.login = null; }
    catch (e) { st.setupError = e.message; }
    finally { st.setupBusy = ""; paint(); }
  }

  async function skipLogin() {
    if (st.setupBusy || st.connectionBusy) return;
    st.setupBusy = "skip"; st.setupError = "";
    try {
      if (st.login?.loginId) await post("/api/codex/login-cancel", { loginId: st.login.loginId });
      st.login = null; st.skipLogin = true; LS.set("skipLogin", "1"); completeSetup();
    } catch (e) { st.setupError = e.message; }
    finally { st.setupBusy = ""; paint(); }
  }

  async function saveConnectionConfig(value) {
    if (st.connectionBusy) throw new Error(t("正在保存连接设置…"));
    st.connectionBusy = true; paint();
    try {
      syncStatus(await post("/api/codex/connection", value));
      st.login = null; st.setupError = "";
      if (dom.preferences.open) dom.preferences.close();
      paint();
      if (st.threadId) await openThread(st.threadId);
      loadThreads();
    } finally { st.connectionBusy = false; paint(); }
  }

  async function useChatGPT() {
    if (st.connectionBusy) return;
    try {
      if (st.status?.connection?.mode === "custom") await saveConnectionConfig({ mode: "chatgpt" });
      await login();
    } catch (e) { toast(t(e.message), true); }
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
    if (dom.preferences.open) dom.preferences.close();
    try { await post("/api/codex/logout"); st.login = null; toast("已退出"); refreshSoon(); }
    catch (e) { toast(e.message, true); }
  }

  async function saveSettings(model, effort) {
    if (st.settingsBusy) return;
    st.settingsBusy = true; paint();
    try {
      const saved = await post("/api/codex/settings", { model, effort });
      st.model = saved.model; st.effort = saved.effort;
      if (st.status) Object.assign(st.status, saved);
      LS.set("model", st.model); LS.set("effort", st.effort);
      toast(t("设置已保存，将用于下一次发送。"));
    } catch (e) { toast(e.message, true); }
    finally { st.settingsBusy = false; paint(); if (dom.preferences.open) paintSettings(); }
  }

  function openSettings(tab = "general") {
    if (!st.open) CC.openPage("codex");
    ensureDom(); st.settingsTab = tab; paintSettings();
    if (!dom.preferences.open) dom.preferences.showModal();
    if (tab === "extensions") loadExtensions();
  }
  function paintSettings() {
    st.cancelConnectionForm?.();
    const body = $("cx-preferences-body"), s = st.status || {};
    body.hidden = st.settingsTab === "device";
    $("cx-device-settings").hidden = st.settingsTab !== "device";
    dom.preferences.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === st.settingsTab ? "page" : "false"));
    if (st.settingsTab === "device") { CC.mountDeviceSettings($("cx-device-settings")); return; }
    if (st.settingsTab === "extensions") { paintExtensions(); return; }
    if (st.settingsTab === "connection") { paintConnection(); return; }
    const models = (s.models || []).filter((m) => !m.hidden);
    const cur = models.find((m) => m.id === st.model) || models.find((m) => m.isDefault) || models[0];
    const row = (name, value) => `<div class="cx-pref-row"><b>${esc(t(name))}</b><span>${value}</span></div>`;
    body.innerHTML = `<section><h3>${esc(t("账号与模型"))}</h3>
      ${row("连接方式", `<span>${esc(s.connection?.mode === "custom" ? t("自定义 API") : s.account?.email || t("尚未连接模型"))}</span><button data-act="connection">${esc(t("配置连接"))}</button>${s.account && s.connection?.mode !== "custom" ? `<button data-act="logout">${esc(t("退出登录"))}</button>` : ""}`)}
      <form id="cx-settings-form"><label>${esc(t("模型"))}<select id="cx-pref-model"${!models.length || st.settingsBusy ? " disabled" : ""}><option value="">${esc(t("默认模型"))}</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === st.model ? " selected" : ""}>${esc(m.displayName || m.id)}</option>`).join("")}</select></label>
      <label>${esc(t("思考强度"))}<select id="cx-pref-effort"><option value="">${esc(t("默认"))}</option>${(cur?.supportedReasoningEfforts || []).map((e) => `<option value="${esc(e.reasoningEffort)}"${e.reasoningEffort === st.effort ? " selected" : ""}>${esc(e.reasoningEffort)}</option>`).join("")}</select></label>
      <p>${esc(t("模型和思考强度保存在本机，将用于下一次发送。"))}</p><button class="cx-pref-save" type="submit"${st.settingsBusy || !models.length ? " disabled" : ""}>${esc(t("保存"))}</button></form></section>
      <section><h3>${esc(t("权限与运行"))}</h3><p>${esc(t("非受信命令由 Codex 请求确认。任务以安卓应用身份执行，可访问本应用和已授权的共享目录；当前未启用额外的项目目录隔离。"))}</p>
      ${row("审批策略", "<code>untrusted</code>")}${row("执行沙箱", "<code>danger-full-access</code>")}
      ${row("后台任务", esc(t("正在运行 {n} 个任务", { n: st.running.size })))}<button data-act="device-settings">${esc(t("应用与设备设置"))}</button></section>
      <section><h3>${esc(t("通知"))}</h3><div id="cx-notify-status">${esc(t("加载中…"))}</div></section>
      <section><h3>${esc(t("外观与语言"))}</h3><label>${esc(t("外观"))}<select id="cx-pref-theme">${[["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([v, k]) => `<option value="${v}"${v === (window.Theme?.pref || "auto").replace(/^(qs|zy|gc|ss)-/, "") ? " selected" : ""}>${esc(t(k))}</option>`).join("")}</select></label>
      <label>${esc(t("语言"))}<select id="cx-pref-lang"><option value="auto">${esc(t("跟随系统"))}</option>${(window.I18N?.langs || []).map((l) => `<option value="${esc(l.code)}"${l.code === I18N.pref ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label></section>
      <section><h3>${esc(t("引擎"))}</h3>${row("Codex 版本", esc(s.version || "—"))}${row("状态", esc(t(s.server ? "就绪" : "引擎未启动")))}<p class="cx-pref-path">${esc(s.paths?.codexHome || "")}</p></section>`;
    $("cx-settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings($("cx-pref-model").value, $("cx-pref-effort").value); });
    $("cx-pref-model").addEventListener("change", (e) => {
      const selected = models.find((m) => m.id === e.target.value) || models.find((m) => m.isDefault) || models[0];
      $("cx-pref-effort").innerHTML = `<option value="">${esc(t("默认"))}</option>` + (selected?.supportedReasoningEfforts || []).map((x) => `<option value="${esc(x.reasoningEffort)}">${esc(x.reasoningEffort)}</option>`).join("");
    });
    $("cx-pref-theme").addEventListener("change", (e) => { const prefix = (window.Theme?.pref || "").match(/^(qs|zy|gc|ss)-/)?.[0] || ""; window.Theme?.set(prefix + e.target.value); });
    $("cx-pref-lang").addEventListener("change", (e) => { saveDraft(); window.I18N?.setLang(e.target.value); });
    loadNotifySettings();
  }

  function paintConnection() {
    const body = $("cx-preferences-body"), c = st.status?.connection || {};
    body.innerHTML = `<section class="cx-connection-account"><div><h3>ChatGPT</h3><p>${esc(t("独立客户端 · 非 OpenAI 官方应用"))}</p></div>
      <button data-act="connection-chatgpt"${st.connectionBusy ? " disabled" : ""}>${esc(t("使用 ChatGPT 登录"))}</button></section>
      <section class="cx-api-section"><h3>${esc(t("自定义第三方 API"))}</h3><p>${esc(t("填写服务商的 API 地址与密钥，获取模型后测试连接。"))}</p>
      <form id="cx-connection-form" autocomplete="off"><fieldset${st.connectionBusy ? " disabled" : ""}>
        <label>${esc(t("API 基础地址"))}<input id="cx-api-url" type="url" required maxlength="2048" value="${esc(c.baseUrl || "")}" placeholder="https://example.com/v1" autocapitalize="off" spellcheck="false" aria-describedby="cx-api-url-help"></label>
        <p id="cx-api-url-help">${esc(t("请使用 API 地址而非网站首页；也可粘贴完整的 /responses 或 /chat/completions 地址。"))}</p>
        <label>${esc(t("API 协议"))}<select id="cx-api-protocol"><option value="auto">${esc(t("自动识别（测试连接后确定）"))}</option><option value="responses">OpenAI Responses</option><option value="chat">OpenAI Chat Completions</option></select></label>
        <div class="cx-api-preview"><span>${esc(t("请求地址"))}</span><code id="cx-api-preview"></code></div>
        <label>API Key<div class="cx-api-key-row"><input id="cx-api-key" type="password" autocomplete="new-password" maxlength="16384" placeholder="${esc(t(c.hasKey ? "已保存密钥，留空则保留" : "输入你的 API Key"))}"${c.noKey ? " disabled" : ""}><button type="button" id="cx-api-key-toggle" aria-pressed="false">${esc(t("显示"))}</button></div></label>
        <label class="cx-pref-check"><span>${esc(t("此接口无需 API Key"))}</span><input id="cx-api-no-key" type="checkbox"${c.noKey ? " checked" : ""}></label>
        <div class="cx-api-model-heading"><label for="cx-api-model">${esc(t("模型名称"))}</label><button type="button" id="cx-api-fetch">${esc(t("获取模型"))}</button></div>
        <input id="cx-api-model" required maxlength="200" value="${esc(c.model || "")}" placeholder="${esc(t("选择获取到的模型，或手动输入"))}" list="cx-api-models" autocapitalize="off" spellcheck="false"><datalist id="cx-api-models"></datalist>
        <p id="cx-api-model-status" role="status" aria-live="polite">${esc(t("填写地址和密钥后自动获取模型，也可手动填写。"))}</p>
        <div class="cx-api-test-bar"><button type="button" id="cx-api-test">${esc(t("测试连接"))}</button><span>${esc(t("会发送短模型请求，可能产生少量费用。"))}</span></div>
        <div id="cx-api-result" class="cx-api-result" role="status" aria-live="polite" hidden></div>
        <details class="cx-api-notes"><summary>${esc(t("密钥与兼容性说明"))}</summary><p>${esc(t("密钥保存在应用私有目录，不会显示在状态信息中。更换地址时请重新填写密钥。"))}</p><p>${esc(t("Chat Completions 通过本地适配支持文本、图片与工具调用；其他能力优先使用 Responses。测试成功不代表所有工具能力均受支持。"))}</p></details>
        <p id="cx-connection-error" class="cx-form-error" role="alert"></p>
        <button type="submit" class="cx-pref-save">${esc(t("保存并使用 API"))}</button>
      </fieldset></form></section>`;
    const form = $("cx-connection-form"), protocol = $("cx-api-protocol"), url = $("cx-api-url"), key = $("cx-api-key"), model = $("cx-api-model"), noKey = $("cx-api-no-key");
    protocol.value = c.mode === "custom" ? c.wireApi || "responses" : "auto";
    let revision = 0, controller = null, timer = 0, busy = false, disposed = false;
    const value = () => ({ mode: "custom", baseUrl: url.value, wireApi: protocol.value, model: model.value, apiKey: key.value, noKey: noKey.checked });
    const normalized = () => { try { const u = new URL(url.value.trim()); u.pathname = u.pathname.replace(/\/(responses|chat\/completions|models)\/?$/, ""); return u.href.replace(/\/+$/, ""); } catch { return ""; } };
    const preview = () => {
      $("cx-api-preview").textContent = normalized() ? normalized() + (protocol.value === "chat" ? "/chat/completions" : protocol.value === "auto" ? "/responses · /chat/completions" : "/responses") : "https://example.com/v1";
      key.placeholder = t(c.hasKey && normalized() === c.baseUrl ? "已保存密钥，留空则保留" : "输入你的 API Key");
    };
    const buttons = () => { $("cx-api-fetch").disabled = busy; $("cx-api-test").disabled = busy; form.querySelector("[type=submit]").disabled = busy; };
    const reset = (catalog = false) => {
      revision++; controller?.abort(); controller = null; clearTimeout(timer); busy = false; buttons();
      $("cx-api-result").hidden = true; $("cx-connection-error").textContent = "";
      if (catalog) { $("cx-api-models").innerHTML = ""; $("cx-api-model-status").textContent = t("填写地址和密钥后自动获取模型，也可手动填写。"); }
      preview();
    };
    const cleanup = () => { disposed = true; revision++; controller?.abort(); clearTimeout(timer); dom.preferences.removeEventListener("close", cleanup); if (st.cancelConnectionForm === cleanup) st.cancelConnectionForm = null; };
    st.cancelConnectionForm = cleanup; dom.preferences.addEventListener("close", cleanup);
    const current = (id) => !disposed && form.isConnected && revision === id;
    async function probe(kind) {
      clearTimeout(timer); if (disposed || busy) return;
      if (!url.reportValidity() || (kind === "test" && !model.reportValidity())) return;
      reset(); const id = revision; controller = new AbortController(); busy = true; buttons();
      const label = $("cx-api-model-status"), result = $("cx-api-result");
      if (kind === "models") label.textContent = t("正在获取模型…");
      else { result.hidden = false; result.dataset.state = "pending"; result.textContent = t("正在测试连接…"); }
      try {
        const r = await api("/api/codex/connection/" + kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value()), signal: controller.signal });
        if (!current(id)) return;
        if (r.ok && r.baseUrl) { url.value = r.baseUrl; preview(); }
        if (kind === "models") {
          $("cx-api-models").innerHTML = (r.models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
          label.textContent = r.ok ? t("已获取 {n} 个模型，可输入名称筛选。", { n: r.models.length }) : t(r.message) + " · " + t("可继续手动填写模型名称。");
          if (r.ok && !model.value) model.value = r.models[0];
        } else {
          result.dataset.state = r.ok ? "ok" : "error";
          if (r.ok) { protocol.value = r.wireApi; preview(); }
          result.innerHTML = `<b>${esc(r.ok ? t("连接测试成功") : t("连接测试失败"))}</b><p>${esc(r.ok ? (r.wireApi === "chat" ? "Chat Completions" : "Responses") + " · " + r.elapsedMs + " ms · " + r.model : t(r.message))}</p><details><summary>${esc(t("请求详情"))}</summary>${(r.attempts || []).map((a) => `<p><code>${esc(a.url)}</code><br>${esc(a.status ? "HTTP " + a.status : a.code || "OK")} · ${esc(a.elapsedMs)} ms${a.message ? " · " + esc(t(a.message)) : ""}</p>`).join("")}</details>`;
        }
      } catch (err) {
        if (!current(id) || err.name === "AbortError") return;
        if (kind === "models") label.textContent = t(err.message);
        else { result.dataset.state = "error"; result.textContent = t(err.message); }
      } finally { if (current(id)) { busy = false; controller = null; buttons(); } }
    }
    const autoModels = () => {
      clearTimeout(timer);
      const savedKey = c.hasKey && normalized() === c.baseUrl;
      if (normalized() && (key.value.trim() || noKey.checked || savedKey)) timer = setTimeout(() => probe("models"), 400);
    };
    for (const field of [url, key, noKey]) {
      field.addEventListener("input", () => { reset(true); key.disabled = noKey.checked; });
      field.addEventListener("change", autoModels);
    }
    url.addEventListener("change", () => {
      if (/\/chat\/completions\/?$/.test(url.value.trim())) protocol.value = "chat";
      else if (/\/responses\/?$/.test(url.value.trim())) protocol.value = "responses";
      preview();
    });
    protocol.addEventListener("change", () => reset()); model.addEventListener("input", () => reset());
    $("cx-api-fetch").addEventListener("click", () => probe("models")); $("cx-api-test").addEventListener("click", () => probe("test"));
    $("cx-api-key-toggle").addEventListener("click", (e) => { key.type = key.type === "password" ? "text" : "password"; e.currentTarget.textContent = t(key.type === "password" ? "显示" : "隐藏"); e.currentTarget.setAttribute("aria-pressed", String(key.type === "text")); });
    preview();
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const form = e.currentTarget;
      if (busy) return;
      if (protocol.value === "auto") { $("cx-connection-error").textContent = t("请先测试连接以识别协议，或手动选择协议。"); return; }
      clearTimeout(timer);
      form.querySelector("fieldset").disabled = true; $("cx-connection-error").textContent = "";
      try { await saveConnectionConfig(value()); toast(t("连接设置已保存，发送任务时将使用此 API。")); }
      catch (err) { if (form.isConnected) $("cx-connection-error").textContent = t(err.message); }
      finally { if (form.isConnected) form.querySelector("fieldset").disabled = false; }
    });
  }
  async function loadNotifySettings() {
    const box = $("cx-notify-status");
    if (!box) return;
    try {
      const s = await api("/api/app/notify_status");
      if (!box.isConnected) return;
      if (!s.ok) { box.textContent = t("系统通知在安卓应用中可用。"); return; }
      box.innerHTML = [ ["done", "任务完成通知"], ["ask", "等待确认通知"] ].map(([k, title]) => `<label class="cx-pref-check"><span>${esc(t(title))}</span><input type="checkbox" data-notify="${k}"${s[k] ? " checked" : ""}></label>`).join("")
        + ((!s.system || (s.done && !s.chDone) || (s.ask && !s.chAsk)) ? `<p>${esc(t("系统已关闭部分通知，请在系统设置中开启。"))}</p>` : "")
        + `<button data-act="notify-settings">${esc(t("系统通知设置"))}</button>`;
      box.querySelectorAll("[data-notify]").forEach((el) => el.addEventListener("change", async () => {
        el.disabled = true;
        try { const r = await post("/api/app/notify_set", { [el.dataset.notify]: el.checked }); if (r.ok === false) throw new Error(r.message || t("保存失败")); }
        catch (e) { toast(e.message, true); }
        finally { loadNotifySettings(); }
      }));
    } catch (e) { if (box.isConnected) box.textContent = t("读取失败") + ": " + e.message; }
  }
  async function loadExtensions() {
    const seq = ++st.extensionsSeq;
    st.extensionsBusy = true; st.extensionsError = ""; paintExtensions();
    try { const r = await api("/api/codex/extensions?cwd=" + encodeURIComponent(currentCwd())); if (seq === st.extensionsSeq) st.extensions = r; }
    catch (e) { if (seq === st.extensionsSeq) st.extensionsError = e.message; }
    finally { if (seq === st.extensionsSeq) { st.extensionsBusy = false; paintExtensions(); } }
  }
  function paintExtensions() {
    if (st.settingsTab !== "extensions") return;
    const box = $("cx-preferences-body"), data = st.extensions;
    const btn = (dir) => `<button data-act="extension-files" data-dir="${esc(dir)}">${esc(t("打开目录"))}</button>`;
    box.innerHTML = `<div class="cx-pref-row"><p>${esc(currentCwd())}</p><button data-act="extensions-refresh"${st.extensionsBusy ? " disabled" : ""}>${esc(t("刷新"))}</button></div>`;
    if (st.extensionsBusy) { box.innerHTML += `<p>${esc(t("加载中…"))}</p>`; return; }
    if (st.extensionsError) { box.innerHTML += `<p class="cx-form-error" role="alert">${esc(st.extensionsError)}</p>`; return; }
    if (!data) return;
    const skills = (data.skills || []).flatMap((g) => g.skills || []);
    box.innerHTML += `<section><h3>${esc(t("技能"))} <small>${skills.length}</small></h3><p>${esc(t("由 Codex 按当前项目发现，开关保存到 Codex 配置。"))}</p>
      ${data.skillsError ? `<p class="cx-form-error">${esc(data.skillsError)}</p>` : skills.map((s) => `<article class="cx-extension"><div><b>${esc(s.interface?.displayName || s.name)}</b><p>${esc(s.description || "")}</p><code>${esc(s.path || "")}</code></div><button data-act="skill-toggle" data-path="${esc(s.path || "")}" data-enabled="${!s.enabled}"${s.path ? "" : " disabled"}>${esc(t(s.enabled ? "停用" : "启用"))}</button></article>`).join("") || `<p>${esc(t("当前项目没有发现技能。"))}</p>`}
      ${(data.skills || []).flatMap((g) => g.errors || []).map((e) => `<p class="cx-form-error">${esc(e.message || e.path || JSON.stringify(e))}</p>`).join("")}</section>
      <section><h3>MCP</h3><p>${esc(t("显示 Codex 已加载的服务与认证状态。"))}</p>${data.mcpError ? `<p class="cx-form-error">${esc(data.mcpError)}</p>` : (data.mcp || []).map((s) => `<article class="cx-extension"><div><b>${esc(s.name)}</b><p>${esc(t("认证状态"))}: ${esc(s.authStatus || "—")}</p><small>${esc(t("工具"))}: ${Object.keys(s.tools || {}).length}</small></div></article>`).join("") || `<p>${esc(t("尚未配置 MCP 服务。"))}</p>`}
      ${data.mcpNextCursor ? `<p>${esc(t("仅显示前 100 个服务。"))}</p>` : ""}</section>
      <section><h3>${esc(t("项目指引"))}</h3><p class="cx-pref-path">${esc(data.agentsPath)}</p><p>${esc(t("在项目目录中创建或编辑 AGENTS.md，为后续任务提供项目约定。"))}</p>${btn(data.cwd)}</section>
      <section><h3>${esc(t("Codex 配置"))}</h3><p class="cx-pref-path">${esc(data.configPath)}</p><p>${esc(t("在 config.toml 中配置 MCP。修改后重启应用以重新加载服务；正在运行的任务请先完成。"))}</p>${btn(data.codexHome)}</section>`;
  }
  async function toggleSkill(el) {
    el.disabled = true;
    try { await post("/api/codex/skill", { cwd: currentCwd(), path: el.dataset.path, enabled: el.dataset.enabled === "true" }); await loadExtensions(); }
    catch (e) { el.disabled = false; toast(e.message, true); }
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
  function back() {
    if (!st.open) return false;
    if (dom.mobileMenu.open) { dom.mobileMenu.close(); return true; }
    if (dom.preferences.open) { dom.preferences.close(); return true; }
    if (dom.dialog.open) { dom.dialog.close(); return true; }
    if (st.sidebar) { toggleSidebar(false); return true; }
    if (st.review) { toggleReview(false); return true; }
    return false;
  }
  function onOpen() {
    ensureDom();
    st.open = true;
    syncMobileLayout();
    st.autoResumed = false;
    const pb = document.getElementById("page-body");
    if (pb) pb.classList.add("cx-on");
    document.documentElement.classList.add("cx-workspace");
    toggleSidebar(false); restoreDraft(); loadProjects(); loadReview();
    connect();
    refresh();
    setTimeout(scrollBottom, 60);
  }
  function onHide() {
    saveDraft();
    clearTimeout(refreshTimer); clearTimeout(threadTimer);
    st.open = false;
    const pb = document.getElementById("page-body");
    if (pb) pb.classList.remove("cx-on");
    document.documentElement.classList.remove("cx-workspace");
    if (dom.dialog.open) dom.dialog.close();
    if (dom.preferences.open) dom.preferences.close();
    if (dom.mobileMenu.open) dom.mobileMenu.close();
    disconnect();
  }

  ensureDom();
  async function openNotification(id) {
    if (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)) return;
    saveDraft();
    if (!st.open) CC.openPage?.("codex");
    st.autoResumed = true;
    while (st.switching || st.busy) await new Promise((resolve) => setTimeout(resolve, 100));
    await openThread(id);
  }
  window.CODEX = { onOpen, onHide, refresh, openThread, openNotification, openSettings, newThread, back,
    openSidebar: () => toggleSidebar(true),
    closeSettings: () => dom.preferences.close(),
    deviceSettingsOpen: () => dom.preferences.open && st.settingsTab === "device",
    get state() { return st; } };
  CC.openPage("codex");
  $("cx-loading")?.remove();
})();
