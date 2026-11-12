// ─────────────────────────────────────────────────────────────────────
//  Codex 工作台：官方 codex-app-server 的进程、登录、线程、轮次和审批
//
//  这里只管「引擎」这一侧：下载官方静态二进制、按钉住的 sha256 核、起进程、把
//  JSON-RPC（stdio，一行一条）翻成界面能用的事件。界面在 web/codex.js。
//
//  几条硬边界：
//    · 二进制只从 openai/codex 的固定 Release 下载，sha256 钉死；装好后再按二进制
//      自己的 sha256 核一次，与工具包 / pkg 无关。
//    · 只监听回环的 CONNECT 代理 + CA 包，给这个静态 musl 程序联网用；代理要口令，
//      别的本机应用拿不到。
//    · 命令以本应用 uid 执行，不开 root、不碰 Shizuku。sandbox 用 danger-full-access
//      （安卓内核本身已经把应用关在自己的沙箱里，bubblewrap 在多数机型上起不来），
//      审批策略用 untrusted：模型想跑非只读命令时，必须由界面点确认。
//    · 工具包里的 bash / git / rg 等只作为子进程的 PATH；Codex 本身不依赖工具包。
// ─────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, PREFIX, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 钉住的 Codex 版本 ─────────────────────────────────────────────────
// 升级只改这里，并把新的 tar / 二进制 sha256 一起换掉。和 cccodroid 的 devkit 无关。
const CODEX = {
  version: "0.166.0",
  asset: "codex-app-server-aarch64-unknown-linux-musl.tar.gz",
  url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-app-server-aarch64-unknown-linux-musl.tar.gz",
  size: 88007340,
  sha256: "3bc8dce2c2d8df023574736e7439ff834c3825d584dc79aa9b1f642023555bb1",
  binSha256: "f21b0b95117d4f32151abe78d8030cc1175e877fe741deaaea46451f2b51ade2",
  binName: "codex-app-server",
};
// 国内 GitHub 直连不顺时的第三方加速；内容照样按钉住的 sha256 核。仅在直连失败时用。
const PROXY_PREFIX = "https://gh-proxy.com/";

const ROOT = path.join(CFG.home, ".local", "share", "coxdragon", "codex");
const BIN = path.join(ROOT, CODEX.binName);
const CODEX_HOME = process.env.CCAPP_CODEX_HOME || path.join(CFG.home, ".codex");
const CACHE = path.join(CFG.home, ".cache", "coxdragon");
const LOG_LIMIT = 24 * 1024;

// ── 小工具 ───────────────────────────────────────────────────────────
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mkdir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch {} };
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}
function writeAtomic(file, data, mode = 0o600) {
  mkdir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}
function json(res, code, obj) { return sendJson(res, code, obj); }
function errMsg(e) { return e && e.message ? e.message : String(e || "unknown error"); }
function safeCwd(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 4096 || s.includes("\0")) return "";
  if (!path.isAbsolute(s)) return "";
  if (s.split("/").includes("..")) return "";
  return isDir(s) ? s : "";
}

// ── 安装状态 ─────────────────────────────────────────────────────────
const INSTALL = { state: "idle", phase: "", done: 0, total: 0, error: "", startedAt: 0, finishedAt: 0 };
let installTask = null;
let binCache = { key: "", ok: false, error: "" };

function binInfo() {
  let st;
  try { st = fs.statSync(BIN); } catch { return { installed: false }; }
  return { installed: st.isFile(), size: st.size, mtime: st.mtimeMs, path: BIN, version: CODEX.version };
}

/** 装好以后核一次二进制自己的哈希；文件没变就复用上次结果 */
async function verifyBin() {
  const info = binInfo();
  if (!info.installed) throw new Error("Codex 引擎还没安装");
  // 每次起进程都重新算，不按 mtime/size 缓存：同 uid 的终端进程能在同一秒里换掉文件、
  // 把大小和 mtime 都改回去，缓存就成了绕过点。215 MB 算一次不到一秒，起进程不是热路径。
  const got = await sha256File(BIN);
  binCache = { key: `${info.size}:${info.mtime}`, ok: got === CODEX.binSha256, error: got === CODEX.binSha256 ? "" : `Codex 引擎的 sha256 是 ${got}，钉的是 ${CODEX.binSha256}；请重新安装` };
  if (!binCache.ok) throw new Error(binCache.error);
}

function broadcastInstall() {
  broadcast({ type: "install", install: { ...INSTALL, installed: binInfo().installed, version: CODEX.version } });
}

async function downloadTo(url, dest, onProgress) {
  const part = dest + ".part";
  let start = 0;
  try { start = fs.statSync(part).size; } catch {}
  if (start > CODEX.size) { try { fs.rmSync(part); } catch {} start = 0; }
  const headers = { "user-agent": "coxdragon-codex/0.1" };
  if (start > 0) headers.range = `bytes=${start}-`;
  let res;
  try { res = await fetch(url, { redirect: "follow", headers }); }
  catch (e) {
    if (start > 0) { try { fs.rmSync(part); } catch {} }
    throw e;
  }
  if (res.status === 416) { try { fs.rmSync(part); } catch {} throw new Error("续传位置无效，已重新开始"); }
  if (!res.ok) throw new Error(`下载 Codex 引擎失败：HTTP ${res.status}`);
  let append = start > 0 && res.status === 206;
  if (!append) start = 0;
  const total = Number(res.headers.get("content-length") || 0) + start || CODEX.size;
  INSTALL.total = total;
  const fh = await fs.promises.open(part, append ? "a" : "w");
  let done = start;
  try {
    for await (const chunk of res.body) {
      let off = 0;
      while (off < chunk.length) {
        const w = await fh.write(chunk, off, chunk.length - off);
        off += w.bytesWritten;
      }
      done += chunk.length;
      INSTALL.done = done;
      if (onProgress) onProgress(done, total);
    }
    await fh.sync();
  } finally { await fh.close(); }
  const got = await sha256File(part);
  if (got !== CODEX.sha256) {
    try { fs.rmSync(part); } catch {}
    throw new Error(`Codex 引擎包的 sha256 是 ${got}，与钉住的 ${CODEX.sha256} 不符`);
  }
  fs.renameSync(part, dest);
  return dest;
}

/** 流式解 gzip tar 里的那个 codex-app-server，别的条目跳过。不走 tar 命令，少一个依赖。 */
async function extractAppServer(tarGz, outFile) {
  const input = fs.createReadStream(tarGz).pipe(zlib.createGunzip());
  let buf = Buffer.alloc(0);
  let state = "header";   // header | data | skip | pad | done
  let rem = 0, pad = 0, fd = -1, found = false;
  const tmp = outFile + ".tmp-" + process.pid;
  try { fs.rmSync(tmp, { force: true }); } catch {}
  const closeOut = () => { if (fd >= 0) { try { fs.fsyncSync(fd); } catch {} try { fs.closeSync(fd); } catch {} fd = -1; } };
  try {
    for await (const chunk of input) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (state === "header") {
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512); buf = buf.subarray(512);
          const name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
          const size = parseInt(h.toString("ascii", 124, 136).replace(/\0.*$/, "").trim() || "0", 8) || 0;
          const type = h[156];
          if (!name) { state = "done"; break; }
          rem = size;
          pad = (512 - (size % 512)) % 512;
          if ((type === 0 || type === 48) && /(^|\/)codex-app-server/.test(name)) {
            fd = fs.openSync(tmp, "w", 0o755);
            found = true;
            state = "data";
          } else {
            state = "skip";
          }
        } else if (state === "data" || state === "skip") {
          if (!buf.length) break;
          const n = Math.min(buf.length, rem);
          if (state === "data" && n > 0) fs.writeSync(fd, buf, 0, n);
          buf = buf.subarray(n); rem -= n;
          if (rem <= 0) { state = "pad"; if (state === "pad" && pad === 0) { if (found) state = "done"; else state = "header"; } }
        } else if (state === "pad") {
          const n = Math.min(buf.length, pad);
          buf = buf.subarray(n); pad -= n;
          if (pad <= 0) { if (found) state = "done"; else state = "header"; }
        } else break;
      }
      if (state === "done") break;
    }
  } finally { closeOut(); try { input.destroy(); } catch {} }
  if (!found) { try { fs.rmSync(tmp, { force: true }); } catch {} throw new Error("下载的包里没有 codex-app-server"); }
  const got = await sha256File(tmp);
  if (got !== CODEX.binSha256) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw new Error(`解出来的 Codex 引擎 sha256 是 ${got}，与钉住的 ${CODEX.binSha256} 不符`);
  }
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, outFile);
}

async function doInstall() {
  mkdir(ROOT); mkdir(CACHE);
  INSTALL.state = "installing"; INSTALL.phase = "下载官方 Codex 引擎（约 84 MB）"; INSTALL.done = 0; INSTALL.total = CODEX.size; INSTALL.error = ""; INSTALL.startedAt = Date.now(); INSTALL.finishedAt = 0;
  broadcastInstall();
  const tar = path.join(CACHE, CODEX.asset);
  let ok = false;
  const urls = [CODEX.url, PROXY_PREFIX + CODEX.url];
  let last = "";
  for (const u of urls) {
    try {
      await downloadTo(u, tar, (d, t) => { INSTALL.done = d; INSTALL.total = t; if (d === t || d % (4 << 20) < (1 << 20)) broadcastInstall(); });
      ok = true; break;
    } catch (e) { last = errMsg(e); INSTALL.phase = "下载失败，换线路重试"; broadcastInstall(); }
  }
  if (!ok) throw new Error(last || "下载 Codex 引擎失败");
  INSTALL.phase = "解包并校验"; INSTALL.done = 0; INSTALL.total = 0; broadcastInstall();
  await extractAppServer(tar, BIN);
  try { fs.rmSync(tar, { force: true }); } catch {}
  binCache = { key: "", ok: false, error: "" };
  await verifyBin();
  INSTALL.state = "done"; INSTALL.phase = "已就绪"; INSTALL.finishedAt = Date.now();
  broadcastInstall();
}

function startInstall() {
  if (INSTALL.state === "installing") return;
  if (binInfo().installed) { INSTALL.state = "done"; INSTALL.phase = "已就绪"; INSTALL.done = INSTALL.total = 0; broadcastInstall(); return; }
  INSTALL.state = "installing"; INSTALL.phase = "准备下载"; INSTALL.error = ""; INSTALL.done = 0; INSTALL.total = CODEX.size;
  broadcastInstall();
  installTask = doInstall().catch((e) => {
    INSTALL.state = "error"; INSTALL.phase = "安装失败"; INSTALL.error = errMsg(e); INSTALL.finishedAt = Date.now();
    log("[codex] 安装失败：" + errMsg(e));
    broadcastInstall();
  }).finally(() => { installTask = null; });
}

// ── 联网：只监听回环的 CONNECT 代理 + 给静态 musl 用的 CA bundle ───────
let proxy = null;
let caCache = { path: "", at: 0 };
function ensureProxy() {
  if (proxy) return proxy;
  const user = "coxdragon", pass = crypto.randomBytes(18).toString("hex");
  const want = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
  const srv = http.createServer((req, res) => {
    if (req.headers["proxy-authorization"] !== want) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="coxdragon"' }); return res.end(); }
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (target.protocol !== "http:") { res.writeHead(400); return res.end(); }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const up = http.request({ host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res);
    });
    up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(up);
  });
  srv.on("connect", (req, socket, head) => {
    if (req.headers["proxy-authorization"] !== want) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"coxdragon\"\r\n\r\n");
      return;
    }
    let host = "", port = 443;
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(req.url) || /^([^:]+):(\d+)$/.exec(req.url);
    if (m) { host = m[1]; port = Number(m[2]); } else host = String(req.url || "");
    if (!host || port < 1 || port > 65535) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const up = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => { try { socket.destroy(); } catch {} });
    socket.on("error", () => { try { up.destroy(); } catch {} });
  });
  srv.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      proxy = { srv, port, url: `http://${user}:${pass}@127.0.0.1:${port}` };
      resolve(proxy);
    });
  });
}

/** 给静态 musl 的 CA 包：优先工具包的 cert.pem，没有就从系统 cacerts 合成一份 PEM */
function ensureCa() {
  if (caCache.path && fs.existsSync(caCache.path)) return caCache.path;
  const fromPrefix = PREFIX ? path.join(PREFIX, "etc", "tls", "cert.pem") : "";
  if (fromPrefix && fs.existsSync(fromPrefix)) { caCache = { path: fromPrefix, at: Date.now() }; return fromPrefix; }
  const out = path.join(CACHE, "ca.pem");
  try {
    const dirs = ["/system/etc/security/cacerts", "/apex/com.android.conscrypt/cacerts"];
    const parts = [];
    for (const d of dirs) {
      let list = [];
      try { list = fs.readdirSync(d); } catch { continue; }
      for (const n of list) {
        if (!/^[0-9a-fA-F]+\.\d+$/.test(n)) continue;
        try {
          const der = fs.readFileSync(path.join(d, n));
          const pem = new crypto.X509Certificate(der).toString();
          if (pem.includes("BEGIN CERTIFICATE")) parts.push(pem.trim());
        } catch {}
      }
      if (parts.length) break;
    }
    if (!parts.length) return "";
    writeAtomic(out, parts.join("\n") + "\n", 0o600);
    caCache = { path: out, at: Date.now() };
    return out;
  } catch (e) { log("[codex] 合成 CA 包失败：" + errMsg(e)); return ""; }
}

// ── JSON-RPC over stdio ──────────────────────────────────────────────
class Rpc {
  constructor(child, { onNotify, onRequest } = {}) {
    this.child = child; this.onNotify = onNotify; this.onRequest = onRequest;
    this.nextId = 1; this.pending = new Map(); this.buf = ""; this.dead = false; this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s) => this._data(s));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s) => { this.stderr = (this.stderr + s).slice(-LOG_LIMIT); });
    child.on("exit", (code, signal) => { this.dead = true; for (const [, p] of this.pending) p.reject(new Error(`Codex 引擎退出（code ${code ?? "?"}${signal ? ", " + signal : ""}）`)); this.pending.clear(); });
    child.on("error", (e) => { this.dead = true; for (const [, p] of this.pending) p.reject(e); this.pending.clear(); });
    child.stdin.on("error", (e) => { log("[codex] 引擎 stdin 出错：" + errMsg(e)); });
  }
  _data(s) {
    this.buf += s;
    if (this.buf.length > 32 << 20) { this.buf = ""; log("[codex] 引擎输出单行超过 32 MB，已丢弃"); return; }
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { log("[codex] 引擎输出了非 JSON 行：" + line.slice(0, 200)); continue; }
      if (m && typeof m === "object" && m.method) {
        if (Object.prototype.hasOwnProperty.call(m, "id")) {
          if (this.onRequest) { try { this.onRequest(m); } catch (e) { log("[codex] 处理引擎请求失败：" + errMsg(e)); this.respondError(m.id, -32603, errMsg(e)); } }
          else this.respondError(m.id, -32601, "not supported");
        } else if (this.onNotify) { try { this.onNotify(m); } catch (e) { log("[codex] 处理引擎通知失败：" + errMsg(e)); } }
        continue;
      }
      if (m && typeof m === "object" && Object.prototype.hasOwnProperty.call(m, "id")) {
        const p = this.pending.get(String(m.id));
        if (!p) continue;
        this.pending.delete(String(m.id));
        if (m.error) p.reject(Object.assign(new Error(m.error.message || "Codex 请求失败"), { code: m.error.code, data: m.error.data }));
        else p.resolve(m.result);
      }
    }
  }
  write(obj) {
    if (this.dead) throw new Error("Codex 引擎没有在跑");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params = {}, timeout = 120000) {
    if (this.dead) return Promise.reject(new Error("Codex 引擎没有在跑"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(String(id), { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(String(id)); reject(e); }
    });
  }
  respond(id, result) { try { this.write({ id, result }); } catch {} }
  respondError(id, code, message) { try { this.write({ id, error: { code, message } }); } catch {} }
}

// ── 引擎状态 ─────────────────────────────────────────────────────────
const S = {
  child: null, rpc: null, starting: null,
  account: null, models: [],
  activeThread: null, activeTurn: null,
  cwd: CFG.workspace,
  approvals: new Map(), sse: new Set(),
  lastError: "", stderr: "", startedAt: 0,
  model: "", effort: "",
};

function broadcast(ev) {
  const line = Buffer.from(`data: ${JSON.stringify(ev)}\n\n`);
  for (const c of [...S.sse]) {
    try { if (!c.res.writableEnded) c.res.write(line); }
    catch { S.sse.delete(c); }
  }
}

function slimModel(m) {
  return {
    id: m.id, model: m.model, displayName: m.displayName, description: m.description,
    isDefault: !!m.isDefault, hidden: !!m.hidden,
    defaultReasoningEffort: m.defaultReasoningEffort,
    supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map((x) => ({ reasoningEffort: x.reasoningEffort, description: x.description })),
    inputModalities: m.inputModalities || [],
    serviceTiers: m.serviceTiers || [],
    defaultServiceTier: m.defaultServiceTier ?? null,
    multiAgentVersion: m.multiAgentVersion ?? null,
  };
}
function slimThread(t) {
  if (!t || typeof t !== "object") return null;
  return {
    id: t.id, name: t.name || "", preview: t.preview || "", cwd: t.cwd, model: t.model,
    modelProvider: t.modelProvider, createdAt: t.createdAt, updatedAt: t.updatedAt,
    status: t.status, turns: Array.isArray(t.turns) ? t.turns : undefined,
  };
}

function status() {
  const acc = S.account && S.account.account;
  return {
    installed: binInfo().installed,
    version: CODEX.version,
    install: { ...INSTALL },
    server: !!S.rpc,
    account: acc ? {
      type: acc.type, email: acc.email || "", planType: acc.planType || "",
      workspaceName: acc.workspaceName || "", userId: S.account.userId || "",
      requiresOpenaiAuth: !!S.account.requiresOpenaiAuth,
    } : null,
    models: S.models.map(slimModel),
    activeThread: slimThread(S.activeThread),
    activeTurn: S.activeTurn ? { id: S.activeTurn.id, status: S.activeTurn.status } : null,
    cwd: S.cwd,
    model: S.model || "",
    effort: S.effort || "",
    lastError: S.lastError,
    stderr: (S.rpc ? S.rpc.stderr : S.stderr).slice(-4000),
    proxy: proxy ? { port: proxy.port } : null,
    ca: !!ensureCa(),
    paths: { bin: BIN, codexHome: CODEX_HOME },
  };
}

async function refreshAccount() {
  if (!S.rpc) return null;
  try { S.account = await S.rpc.request("account/read", { refreshToken: false }); }
  catch (e) { S.account = null; log("[codex] account/read 失败：" + errMsg(e)); }
  return S.account;
}
async function refreshModels() {
  if (!S.rpc) return [];
  try { const r = await S.rpc.request("model/list", {}); S.models = Array.isArray(r && r.data) ? r.data : []; }
  catch (e) { log("[codex] model/list 失败：" + errMsg(e)); }
  return S.models;
}

function handleNotify(m) {
  S.stderr = S.rpc ? S.rpc.stderr : S.stderr;
  switch (m.method) {
    case "turn/started": S.activeTurn = m.params && m.params.turn || null; break;
    case "turn/completed": if (!S.activeTurn || !m.params || !m.params.turn || m.params.turn.id === S.activeTurn.id) S.activeTurn = null; break;
    case "thread/started": if (m.params && m.params.thread) S.activeThread = m.params.thread; break;
    case "thread/status/changed": if (m.params && S.activeThread && m.params.threadId === S.activeThread.id) S.activeThread.status = m.params.status; break;
    case "account/login/completed":
      if (m.params && m.params.success) refreshAccount().then(() => refreshModels()).catch(() => {});
      break;
    case "account/updated": refreshAccount().catch(() => {}); break;
    case "error":
      if (m.params && m.params.error) S.lastError = m.params.error.message || "";
      break;
    case "warning":
    case "configWarning":
      if (m.params && m.params.message) log("[codex] " + m.params.message);
      break;
  }
  broadcast({ type: "rpc", method: m.method, params: m.params });
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
function handleRequest(m) {
  if (!APPROVAL_METHODS.has(m.method)) {
    log("[codex] 引擎发来未支持的请求：" + m.method);
    if (S.rpc) S.rpc.respondError(m.id, -32601, "not supported by coxdragon");
    return;
  }
  const pending = { id: m.id, method: m.method, params: m.params };
  S.approvals.set(String(m.id), pending);
  broadcast({ type: "approval", id: String(m.id), method: m.method, params: m.params });
  log(`[codex] 等待确认：${m.method} id=${m.id}`);
}

async function startRpc() {
  await verifyBin();
  mkdir(CODEX_HOME); mkdir(CACHE); mkdir(path.join(CACHE, "tmp"));
  const px = await ensureProxy();
  const ca = ensureCa();
  const env = { ...process.env };
  delete env.LD_PRELOAD; delete env.LD_LIBRARY_PATH; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const pp = PREFIX ? [path.join(PREFIX, "bin"), path.join(PREFIX, "sbin")] : [];
  env.PATH = [...pp, "/system/bin", "/system/xbin", env.PATH || ""].filter(Boolean).join(":");
  env.HOME = CFG.home;
  env.CODEX_HOME = CODEX_HOME;
  env.TMPDIR = path.join(CACHE, "tmp");
  env.SHELL = PREFIX && fs.existsSync(path.join(PREFIX, "bin", "bash")) ? path.join(PREFIX, "bin", "bash") : "/system/bin/sh";
  env.HTTPS_PROXY = px.url; env.HTTP_PROXY = px.url;
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  if (ca) env.SSL_CERT_FILE = ca;
  env.RUST_LOG = env.RUST_LOG || "warn";
  env.NO_COLOR = "1";
  const child = spawn(BIN, ["--listen", "stdio://"], { cwd: isDir(S.cwd) ? S.cwd : CFG.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new Rpc(child, { onNotify: handleNotify, onRequest: handleRequest });
  S.child = child; S.rpc = rpc; S.stderr = ""; S.lastError = ""; S.startedAt = Date.now();
  child.on("exit", (code, signal) => {
    if (S.child === child) {
      S.child = null; S.rpc = null; S.activeTurn = null;
      broadcast({ type: "server", state: "exited", code, signal, stderr: rpc.stderr.slice(-4000) });
      log(`[codex] 引擎退出 code=${code} signal=${signal || ""}`);
    }
  });
  broadcast({ type: "server", state: "starting" });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "coxdragon", title: "coxdragon", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 30000);
  } catch (e) {
    stopServer();
    throw new Error("Codex 引擎初始化失败：" + errMsg(e));
  }
  await refreshAccount();
  await refreshModels();
  broadcast({ type: "server", state: "ready" });
  return rpc;
}

function ensureRpc() {
  if (S.rpc) return Promise.resolve(S.rpc);
  if (S.starting) return S.starting;
  S.starting = startRpc().finally(() => { S.starting = null; });
  return S.starting;
}

function stopServer() {
  const c = S.child;
  S.child = null; S.rpc = null; S.activeTurn = null;
  if (c) { try { c.stdin.end(); } catch {} try { c.kill("SIGTERM"); } catch {} setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 1500).unref(); }
  broadcast({ type: "server", state: "stopped" });
}

process.on("exit", () => { if (S.child) { try { S.child.kill("SIGKILL"); } catch {} } if (proxy) { try { proxy.srv.close(); } catch {} } });

// ── 高级动作 ─────────────────────────────────────────────────────────
async function startThread(cwd) {
  const rpc = await ensureRpc();
  const dir = safeCwd(cwd) || safeCwd(CFG.workspace) || CFG.workspace;
  const params = {
    cwd: dir,
    sandbox: "danger-full-access",
    approvalPolicy: "untrusted",
  };
  if (S.model) params.model = S.model;
  const r = await rpc.request("thread/start", params, 60000);
  if (r && r.thread) { S.activeThread = r.thread; S.activeTurn = null; S.cwd = dir; broadcast({ type: "thread", thread: slimThread(r.thread) }); }
  return r;
}
async function resumeThread(threadId) {
  const rpc = await ensureRpc();
  const r = await rpc.request("thread/resume", {
    threadId: String(threadId),
    sandbox: "danger-full-access",
    approvalPolicy: "untrusted",
  }, 60000);
  if (r && r.thread) { S.activeThread = r.thread; S.activeTurn = null; S.cwd = r.thread.cwd || S.cwd; broadcast({ type: "thread", thread: slimThread(r.thread) }); }
  return r;
}
async function startTurn(text) {
  const s = String(text || "");
  if (!s.trim()) throw new Error("消息是空的");
  if (s.length > 200000) throw new Error("消息太长");
  if (!S.activeThread) await startThread(S.cwd);
  const rpc = await ensureRpc();
  const params = { threadId: S.activeThread.id, input: [{ type: "text", text: s }] };
  if (S.model) params.model = S.model;
  if (S.effort) params.effort = S.effort;
  const r = await rpc.request("turn/start", params, 60000);
  if (r && r.turn) S.activeTurn = r.turn;
  broadcast({ type: "turn", turn: r && r.turn ? { id: r.turn.id, status: r.turn.status } : null });
  return r;
}
async function steerTurn(text) {
  if (!S.activeThread || !S.activeTurn) throw new Error("当前没有在跑的轮次");
  const rpc = await ensureRpc();
  return rpc.request("turn/steer", { threadId: S.activeThread.id, expectedTurnId: S.activeTurn.id, input: [{ type: "text", text: String(text || "") }] }, 60000);
}
async function interruptTurn() {
  if (!S.activeThread || !S.activeTurn) throw new Error("当前没有在跑的轮次");
  const rpc = await ensureRpc();
  return rpc.request("turn/interrupt", { threadId: S.activeThread.id, turnId: S.activeTurn.id }, 30000);
}
async function listThreads() {
  const rpc = await ensureRpc();
  const r = await rpc.request("thread/list", { limit: 50 }, 30000);
  return (r && r.data || []).map(slimThread).filter(Boolean);
}
async function login() {
  const rpc = await ensureRpc();
  return rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 60000);
}
async function loginCancel(loginId) {
  const rpc = await ensureRpc();
  return rpc.request("account/login/cancel", { loginId: String(loginId || "") }, 30000);
}
async function logout() {
  const rpc = await ensureRpc();
  const r = await rpc.request("account/logout", {}, 30000);
  S.account = null;
  return r;
}
function approve(id, decision, answers) {
  const p = S.approvals.get(String(id));
  if (!p) throw new Error("这条确认已经失效");
  S.approvals.delete(String(id));
  const rpc = S.rpc;
  if (!rpc) throw new Error("Codex 引擎没有在跑");
  const d = String(decision || "");
  if (p.method === "item/tool/requestUserInput") {
    const a = answers && typeof answers === "object" ? answers : {};
    rpc.respond(p.id, { answers: a });
  } else if (p.method === "item/permissions/requestApproval") {
    rpc.respond(p.id, { permissions: {}, scope: "turn" });
  } else if (p.method === "mcpServer/elicitation/request") {
    rpc.respond(p.id, { action: d === "accept" ? "accept" : "decline" });
  } else {
    const ok = d === "accept" || d === "acceptForSession";
    rpc.respond(p.id, { decision: ok ? d : d === "cancel" ? "cancel" : "decline" });
  }
  broadcast({ type: "approval-done", id: String(id) });
}

// ── 路由 ─────────────────────────────────────────────────────────────
function sse(req, res) {
  if (S.sse.size >= 8) { res.writeHead(429, { "content-type": "text/plain; charset=utf-8" }); res.end("too many event streams"); return; }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(Buffer.from("retry: 3000\n\n"));
  const c = { res };
  S.sse.add(c);
  const ping = setInterval(() => { try { if (!res.writableEnded) res.write(Buffer.from(": ping\n\n")); } catch {} }, 20000);
  const close = () => { clearInterval(ping); S.sse.delete(c); };
  req.on("close", close); res.on("close", close);
  try { res.write(Buffer.from(`data: ${JSON.stringify({ type: "status", status: status() })}\n\n`)); } catch {}
}

export async function routeCodex(req, res, u, p) {
  if (!p.startsWith("/api/codex/")) return NEXT;
  const method = req.method || "GET";
  try {
    if (method === "GET" && p === "/api/codex/events") { sse(req, res); return; }
    if (method === "GET" && p === "/api/codex/status") { json(res, 200, status()); return; }
    if (method === "GET" && p === "/api/codex/threads") { return json(res, 200, { threads: await listThreads() }); }
    if (method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "请求体不是 JSON" }); }
      if (p === "/api/codex/install") { startInstall(); return json(res, 200, { ok: true, install: { ...INSTALL } }); }
      if (p === "/api/codex/stop") { stopServer(); return json(res, 200, { ok: true }); }
      if (p === "/api/codex/thread") { const r = await startThread(body.cwd); return json(res, 200, { thread: slimThread(r && r.thread) }); }
      if (p === "/api/codex/open-thread") { const r = await resumeThread(body.threadId); return json(res, 200, { thread: slimThread(r && r.thread) }); }
      if (p === "/api/codex/turn") { const r = await startTurn(body.text); return json(res, 200, { turn: r && r.turn ? { id: r.turn.id, status: r.turn.status } : null }); }
      if (p === "/api/codex/steer") { const r = await steerTurn(body.text); return json(res, 200, r || {}); }
      if (p === "/api/codex/interrupt") { const r = await interruptTurn(); return json(res, 200, r || {}); }
      if (p === "/api/codex/login") { const r = await login(); return json(res, 200, r || {}); }
      if (p === "/api/codex/login-cancel") { const r = await loginCancel(body.loginId); return json(res, 200, r || {}); }
      if (p === "/api/codex/logout") { const r = await logout(); return json(res, 200, r || {}); }
      if (p === "/api/codex/approve") { approve(body.id, body.decision, body.answers); return json(res, 200, { ok: true }); }
      if (p === "/api/codex/settings") {
        if (typeof body.model === "string") S.model = body.model.slice(0, 200);
        if (typeof body.effort === "string") S.effort = body.effort.slice(0, 40);
        return json(res, 200, { model: S.model, effort: S.effort });
      }
      if (p === "/api/codex/refresh") { await refreshAccount(); await refreshModels(); return json(res, 200, status()); }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    log("[codex] " + method + " " + p + " → " + errMsg(e));
    return json(res, 500, { error: errMsg(e) });
  }
}
