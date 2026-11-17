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
//    · 命令以本应用 uid 执行，不开 root、不碰 Shizuku。权限由用户选择，
//      每次新建、恢复和发送均传给引擎；无法建立沙箱时不自动放大权限。
//    · 工具包里的 bash / git / rg 等只作为子进程的 PATH；Codex 本身不依赖工具包。
// ─────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, PREFIX, LIVE, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { runFlag } from "./activity.mjs";
import { loadState, writeAtomic as saveState } from "./statefile.mjs";
import { connectionStatus, connectionProfiles, connectionModels, deleteConnectionProfile, prepareConnectionLaunch, updateConnection, updateCustomSelection, connectionErrorMessage, CUSTOM_PROVIDER } from "./codex-connection.mjs";
import { discoverApiModels, testApiConnection } from "./codex-api.mjs";
import { customModels, modelDetails, modelSettings, saveModelSettings, configuredModel, validateModelSettings, searchModelCatalog, refreshModelCatalog } from "./codex-models.mjs";
import { readThreadUsage, normalizeTokenUsage } from "./codex-context.mjs";

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
const PREF_FILE = path.join(CFG.home, "coxdragon-codex.json");
const prefs = loadState(PREF_FILE, { max: 4096, shape: (j) => j && typeof j === "object" && !Array.isArray(j) ? j : undefined }).data;
const CONTEXT_FILE = path.join(CFG.home, "coxdragon-codex-context.json");
const savedContexts = loadState(CONTEXT_FILE, { max: 1 << 20, shape: j => j && typeof j === "object" && !Array.isArray(j) ? j : undefined }).data;
const METRICS_FILE = path.join(CFG.home, "coxdragon-codex-metrics.json");
const savedMetrics = loadState(METRICS_FILE, { max: 1 << 20, shape: j => j && typeof j === "object" && !Array.isArray(j) ? j : undefined }).data;
const PERMISSIONS = {
  read: { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  // Android often cannot create the Linux file sandbox. These modes use the
  // native command approval gate, with the app UID as their execution boundary.
  ask: { sandbox: "danger-full-access", approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
  auto: { sandbox: "danger-full-access", approvalPolicy: "untrusted", approvalsReviewer: "auto_review", sandboxPolicy: { type: "dangerFullAccess" } },
  full: { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
};
function threadPermissions() { const { sandbox, approvalPolicy, approvalsReviewer } = PERMISSIONS[S.permissionMode]; return { sandbox, approvalPolicy, approvalsReviewer }; }
function contextOverride() { return connectionStatus().mode === "custom" ? connectionStatus().contextWindow || 0 : prefs.contextWindow || 0; }
function providerName() { try { return new URL(connectionStatus().baseUrl).hostname; } catch { return "Custom API"; } }

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
  catch (e) { throw e; } // A network error must preserve the already downloaded bytes.
  if (res.status === 416) { try { fs.rmSync(part); } catch {} throw new Error("续传位置无效，已重新开始"); }
  if (!res.ok) throw new Error(`下载 Codex 引擎失败：HTTP ${res.status}`);
  let append = start > 0 && res.status === 206;
  if (res.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") || "");
    if (!range || Number(range[1]) !== start || Number(range[3]) !== CODEX.size || Number(range[2]) < start || Number(range[2]) >= CODEX.size) {
      await res.body?.cancel();
      throw new Error("下载线路的续传范围不匹配，请重试");
    }
  }
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
  const urls = [CODEX.url, PROXY_PREFIX + CODEX.url, PROXY_PREFIX + CODEX.url, PROXY_PREFIX + CODEX.url];
  let last = "";
  for (const u of urls) {
    try {
      INSTALL.phase = "下载官方 Codex 引擎（约 84 MB）"; broadcastInstall();
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
  child: null, rpc: null, starting: null, generation: 0, closeAdapter: null, connectionProbe: null,
  account: null, models: [],
  activeThread: null, activeTurn: null, runningTurns: new Map(), startingTurns: new Set(), endedTurns: new Set(),
  loadedThreads: new Set(), threadCwds: new Map(), operations: new Set(),
  contexts: new Map(Object.entries(savedContexts).filter(([id, value]) => id.length <= 200 && Number.isSafeInteger(value?.last?.totalTokens) && value.last.totalTokens >= 0).slice(-200)), compacting: new Set(),
  cwd: CFG.workspace,
  approvals: new Map(), sse: new Set(),
  lastError: "", stderr: "", startedAt: 0,
  model: connectionStatus().mode === "custom" ? connectionStatus().model : typeof prefs.model === "string" ? prefs.model.slice(0, 200) : "",
  effort: connectionStatus().mode === "custom" ? connectionStatus().effort || "" : typeof prefs.effort === "string" ? prefs.effort.slice(0, 40) : "",
  permissionMode: Object.hasOwn(PERMISSIONS, prefs.permissionMode) ? prefs.permissionMode : "ask",
  metrics: new Map(Object.entries(savedMetrics).filter(([, m]) => m && typeof m.threadId === "string").slice(-300)),
  titles: new Map(),
  diagnostics: [],
};
if(connectionStatus().mode==="custom")S.models=connectionModels();

// Deliberately omit prompts, replies, tool arguments and account credentials.
// Native diagnostic export reads this bounded snapshot even if the UI reconnects.
function recordTaskEvent(method, params = {}) {
  const c = connectionStatus(), turn = params.turn;
  const error = params.error || turn?.error;
  const entry = { at: Date.now(), event: method, threadId: params.threadId || "", turnId: turn?.id || params.turnId || "",
    ...(turn?.status ? { status: turn.status } : {}), ...(error ? { message: connectionErrorMessage(error) } : {}),
    ...(params.willRetry != null ? { willRetry: !!params.willRetry } : {}) };
  S.diagnostics.push(entry); if (S.diagnostics.length > 40) S.diagnostics.shift();
  mkdir(CACHE);
  saveState(path.join(CACHE, "codex-diagnostics.json"), JSON.stringify({ version: CODEX.version, connection: { mode: c.mode, baseUrl: c.baseUrl, wireApi: c.wireApi, model: c.model },
    server: !!S.rpc, lastError: S.lastError, running: [...S.runningTurns].map(([threadId, t]) => ({ threadId, turnId: t.id })), events: S.diagnostics }), { mode: 0o600 });
  log(`[codex] ${method} thread=${entry.threadId} turn=${entry.turnId}${entry.status ? " status=" + entry.status : ""}${entry.willRetry != null ? " retry=" + entry.willRetry : ""}${entry.message ? " " + entry.message : ""}`);
}

const activityListeners = new Set();
export const onCodexActivity = (fn) => { activityListeners.add(fn); return () => activityListeners.delete(fn); };
export function codexActivity() {
  return {
    busy: !!(S.starting || S.operations.size || S.compacting.size || S.runningTurns.size || S.startingTurns.size || S.approvals.size),
    running: S.runningTurns.size, starting: S.startingTurns.size + S.operations.size + (S.starting ? 1 : 0),
    approvals: [...S.approvals.values()].map((p) => ({
      id: "codex:" + p.id, engine: "codex", sessionId: p.params?.threadId || "",
      runId: "codex:" + (p.params?.turnId || ""),
      tool: p.method === "item/tool/requestUserInput" ? "AskUserQuestion" : p.method,
      input: p.params || {}, description: p.params?.reason || "",
    })),
  };
}
function activityChanged(done) {
  const state = codexActivity();
  runFlag(state.busy, "codex");
  for (const fn of activityListeners) {
    try { fn({ type: "codex_state", codex: state }); if (done) fn(done); } catch {}
  }
}
function rememberTitle(thread) {
  if (!thread?.id) return;
  S.titles.set(thread.id, String(thread.name || thread.preview || "Codex").slice(0, 200));
  if (S.titles.size > 200) S.titles.delete(S.titles.keys().next().value);
}

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
    outputModalities: m.outputModalities || [], contextWindow: m.contextWindow || null,
    reasoning: m.reasoning ?? null, capabilitySources: m.capabilitySources || {},
    settings:m.settings||{},referenceId:m.referenceId||null,metadataUpdatedAt:m.metadataUpdatedAt||null,
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
    context: S.contexts.get(t.id) || null,
  };
}

function status() {
  const acc = S.account && S.account.account;
  return {
    installed: binInfo().installed,
    version: CODEX.version,
    install: { ...INSTALL },
    server: !!S.rpc,
    connection: connectionStatus(),
    account: acc ? {
      type: acc.type, email: acc.email || "", planType: acc.planType || "",
      workspaceName: acc.workspaceName || "", userId: S.account.userId || "",
      requiresOpenaiAuth: !!S.account.requiresOpenaiAuth,
    } : null,
    models: S.models.map(slimModel),
    activeThread: slimThread(S.activeThread),
    activeTurn: S.activeTurn ? { id: S.activeTurn.id, status: S.activeTurn.status } : null,
    runningTurns: [...S.runningTurns].map(([threadId, turn]) => ({ threadId, turn: { id: turn.id, status: turn.status } })),
    contexts: Object.fromEntries(S.contexts), compacting: [...S.compacting], metrics: Object.fromEntries(S.metrics), contextWindow: contextOverride(),
    providers: [{ id: "chatgpt",mode:"chatgpt", name: "ChatGPT", models: connectionStatus().mode === "chatgpt" ? S.models.map(slimModel) : [] },...connectionProfiles().map(p=>({...p,models:p.models.map(slimModel)}))],
    approvals: [...S.approvals.values()].map((p) => ({ ...p, id: String(p.id) })),
    cwd: S.cwd,
    model: S.model || "",
    effort: S.effort || "",
    permissions: { mode: S.permissionMode, ...threadPermissions(), boundary: "android-app-uid" },
    lastError: S.lastError,
    stderr: (S.rpc ? S.rpc.stderr : S.stderr).slice(-4000),
    proxy: proxy ? { port: proxy.port } : null,
    ca: !!ensureCa(),
    paths: { bin: BIN, codexHome: CODEX_HOME },
  };
}

async function refreshAccount() {
  const rpc = S.rpc, generation = S.generation;
  if (!rpc) return null;
  try { const account = await rpc.request("account/read", { refreshToken: false }); assertRpc(rpc, generation); S.account = account; }
  catch (e) { if (S.rpc === rpc && S.generation === generation) { S.account = null; log("[codex] account/read 失败：" + errMsg(e)); } }
  return S.account;
}
async function refreshModels() {
  const rpc = S.rpc, generation = S.generation;
  const connection = connectionStatus();
  if (connection.mode === "custom") {
    S.model = connection.model; S.effort = connection.effort || "";
    S.models = connectionModels();
    return S.models;
  }
  if (!rpc) return [];
  try {
    const models=[],seen=new Set();let cursor;
    do{const r=await rpc.request("model/list",{...(cursor?{cursor}:{}),limit:100});assertRpc(rpc,generation);models.push(...(Array.isArray(r?.data)?r.data:[]));cursor=r?.nextCursor;if(!cursor||seen.has(cursor))break;seen.add(cursor);}while(models.length<2000);
    S.models=models.map(m=>configuredModel("chatgpt",{...m,...modelDetails(m,{engine:true})}));
  }
  catch (e) { log("[codex] model/list 失败：" + errMsg(e)); }
  return S.models;
}

async function loadModels(providerId,{signal}={}) {
  if(providerId==="chatgpt"){
    if(connectionStatus().mode!=="chatgpt")return {ok:false,models:[],message:"请先切换到 ChatGPT，再获取账号模型"};
    await ensureRpc();await refreshModels();
    return {ok:S.models.length>0,models:S.models.map(slimModel),status:status(),message:S.models.length?"":"未获取到账号模型，请检查登录状态"};
  }
  const provider=connectionProfiles().find(p=>p.id===providerId);
  if(!provider)throw Object.assign(new Error("请先配置提供商"),{statusCode:400});
  const result=await discoverApiModels({providerId},{signal});
  if(connectionStatus().mode==="custom"&&connectionStatus().providerId===providerId)await refreshModels();
  broadcast({type:"status",status:status()});
  return {...result,models:customModels(provider.baseUrl,provider.model).map(slimModel),status:status()};
}

let contextSaveTimer;
function saveContexts() {
  clearTimeout(contextSaveTimer); contextSaveTimer = null;
  saveState(CONTEXT_FILE, JSON.stringify(Object.fromEntries(S.contexts)), { mode: 0o600 });
  saveState(METRICS_FILE, JSON.stringify(Object.fromEntries(S.metrics)), { mode: 0o600 });
}
function rememberUsage(threadId, usage, turnId) {
  if (typeof threadId !== "string" || !usage || !usage.last) return;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const breakdown = value => normalizeTokenUsage(value);
  if (count(usage.last.totalTokens) == null) return;
  S.contexts.delete(threadId);
  S.contexts.set(threadId, { last: breakdown(usage.last), total: breakdown(usage.total),
    modelContextWindow: count(usage.modelContextWindow) || null, model: S.model||S.activeThread?.model||"",providerId:connectionStatus().mode==="custom"?connectionStatus().providerId:"chatgpt", source:"codex",stale:false,updatedAt: Date.now() });
  const metric = S.metrics.get(turnId);
  if (metric) {
    const totalOutput = count(usage.total?.outputTokens), lastOutput = count(usage.last?.outputTokens);
    if (metric.baseOutput == null && totalOutput != null && lastOutput != null) metric.baseOutput = Math.max(0, totalOutput - lastOutput);
    metric.outputTokens = totalOutput != null && metric.baseOutput != null ? Math.max(0, totalOutput - metric.baseOutput) : lastOutput;
    metric.total = breakdown(usage.total);
  }
  if (S.contexts.size > 200) S.contexts.delete(S.contexts.keys().next().value);
  if (!contextSaveTimer) contextSaveTimer = setTimeout(saveContexts, 1000).unref();
}

function handleNotify(m) {
  let done;
  S.stderr = S.rpc ? S.rpc.stderr : S.stderr;
  switch (m.method) {
    case "thread/tokenUsage/updated": rememberUsage(m.params?.threadId, m.params?.tokenUsage, m.params?.turnId); break;
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta": {
      const metric = S.metrics.get(m.params?.turnId);
      if (metric && !metric.firstOutputAt) metric.firstOutputAt = Date.now();
      break;
    }
    case "item/started":
      if (m.params?.item?.type === "contextCompaction") S.compacting.add(m.params.threadId);
      break;
    case "item/completed":
      if (m.params?.item?.type === "contextCompaction") {S.compacting.delete(m.params.threadId);const context=S.contexts.get(m.params.threadId);if(context)context.stale=true;}
      break;
    case "turn/started": {
      const p = m.params || {};
      S.lastError = "";
      if (p.threadId && p.turn) S.runningTurns.set(p.threadId, p.turn);
      if (p.turn?.id && !S.metrics.has(p.turn.id)) {
        const c = connectionStatus(); let provider = "ChatGPT"; try { if (c.mode === "custom") provider = new URL(c.baseUrl).hostname; } catch {}
        const selected = S.models.find(m => m.id === S.model) || S.models.find(m => m.isDefault);
        S.metrics.set(p.turn.id, { threadId: p.threadId, turnId: p.turn.id, provider, providerId:c.mode==="custom"?c.providerId:"chatgpt",modelId:S.model||selected?.id||"",model: selected?.displayName || S.model || "", effort: S.effort || selected?.defaultReasoningEffort || "", startedAt: Date.now(), firstOutputAt: null, baseOutput: S.contexts.get(p.threadId)?.total?.outputTokens ?? null, outputTokens: null });
        if (S.metrics.size > 300) S.metrics.delete(S.metrics.keys().next().value);
      }
      if (p.threadId === S.activeThread?.id) S.activeTurn = p.turn || null;
      break;
    }
    case "turn/completed": {
      const p = m.params || {}, running = S.runningTurns.get(p.threadId);
      S.compacting.delete(p.threadId);
      const metric = S.metrics.get(p.turn?.id);
      if (metric) metric.completedAt = Date.now();
      if (contextSaveTimer || metric) saveContexts();
      if (p.turn?.error) S.lastError = connectionErrorMessage(p.turn.error);
      if (p.turn?.id) { S.endedTurns.add(p.turn.id); if (S.endedTurns.size > 200) S.endedTurns.delete(S.endedTurns.values().next().value); }
      if (!running || !p.turn || p.turn.id === running.id) S.runningTurns.delete(p.threadId);
      if (p.threadId === S.activeThread?.id && (!S.activeTurn || !p.turn || p.turn.id === S.activeTurn.id)) S.activeTurn = null;
      for (const [id, a] of S.approvals) if (a.params?.threadId === p.threadId && (a.params?.turnId === p.turn?.id || (!a.params?.turnId && (!running || running.id === p.turn?.id)))) {
        S.approvals.delete(id); broadcast({ type: "approval-done", id });
      }
      if (p.turn?.id) done = { type: "codex_done", engine: "codex", runId: "codex:" + p.turn.id,
        sessionId: p.threadId, text: S.titles.get(p.threadId) || "Codex", failed: p.turn.status === "failed" || !!p.turn.error,
        aborted: p.turn.status === "interrupted" };
      break;
    }
    case "thread/started": if (m.params?.thread) S.loadedThreads.add(m.params.thread.id); break;
    case "thread/status/changed": if (m.params && S.activeThread && m.params.threadId === S.activeThread.id) S.activeThread.status = m.params.status; break;
    case "account/login/completed":
      if (m.params && m.params.success) refreshAccount().then(() => refreshModels()).catch(() => {});
      break;
    case "account/updated": refreshAccount().catch(() => {}); break;
    case "serverRequest/resolved":
      if (m.params?.requestId != null || m.params?.id != null) S.approvals.delete(String(m.params.requestId ?? m.params.id));
      break;
    case "error":
      if (m.params && m.params.error) S.lastError = connectionErrorMessage(m.params.error);
      break;
    case "warning":
    case "configWarning":
      if (m.params && m.params.message) log("[codex] " + m.params.message);
      break;
  }
  if (["turn/started", "turn/completed", "error"].includes(m.method)) recordTaskEvent(m.method, m.params);
  if (["turn/started", "turn/completed", "serverRequest/resolved"].includes(m.method) || (["item/started", "item/completed"].includes(m.method) && m.params?.item?.type === "contextCompaction")) activityChanged(done);
  broadcast({ type: "rpc", method: m.method, params: m.params, metric: S.metrics.get(m.params?.turnId || m.params?.turn?.id),...(m.method==="thread/tokenUsage/updated"?{context:S.contexts.get(m.params?.threadId)}:{}) });
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
  activityChanged();
  broadcast({ type: "approval", id: String(m.id), method: m.method, params: m.params });
  log(`[codex] 等待确认：${m.method} id=${m.id}`);
}

function assertGeneration(generation) {
  if (generation !== S.generation) throw new Error("Codex 引擎已停止，请重新发送");
}
function assertRpc(rpc, generation) {
  assertGeneration(generation);
  if (S.rpc !== rpc) throw new Error("Codex 引擎已停止，请重新发送");
}
async function rpcOperation(action) {
  const generation = S.generation, token = {};
  S.operations.add(token); activityChanged();
  try {
    const rpc = await ensureRpc(); assertRpc(rpc, generation);
    return await action(rpc, () => assertRpc(rpc, generation));
  } finally { S.operations.delete(token); activityChanged(); }
}

async function startRpc(generation) {
  await verifyBin();
  assertGeneration(generation);
  mkdir(CODEX_HOME); mkdir(CACHE); mkdir(path.join(CACHE, "tmp"));
  const px = await ensureProxy();
  assertGeneration(generation);
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
  // 静态 musl 程序在 Android 14+ 会被 seccomp 拦下较新的系统调用，直接 SIGSYS；和 claude 一样套上
  // 「静态程序兼容」的监督器（跟进子进程），让被拦的调用拿到 ENOSYS 自己退回老接口。
  // 只有实际启动进程时才加载兼容监督器，Codex 的协议状态不依赖 Claude 运行时。
  const er = SETTINGS.staticCompat !== false ? (await import("./claude.mjs")).enosysRun() : "";
  assertGeneration(generation);
  const connection = await prepareConnectionLaunch();
  if (generation !== S.generation) { connection.close?.(); assertGeneration(generation); }
  S.closeAdapter = connection.close;
  delete env.COXDRAGON_CUSTOM_API_KEY;
  if (connectionStatus().mode === "custom") { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.OPENAI_BASE_URL; }
  Object.assign(env, connection.env);
  const argv = [...connection.args, "--listen", "stdio://"];
  if (connectionStatus().mode !== "custom" && contextOverride()) argv.unshift("-c", "model_context_window=" + contextOverride());
  const child = spawn(er || BIN, er ? ["-f", BIN, ...argv] : argv, { cwd: isDir(S.cwd) ? S.cwd : CFG.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  // 停止或换过引擎之后，旧进程缓冲区里剩下的事件和审批不能进入新会话。
  const rpc = new Rpc(child, {
    onNotify: (m) => { if (S.child === child) handleNotify(m); },
    onRequest: (m) => { if (S.child === child) handleRequest(m); },
  });
  S.child = child; S.rpc = rpc; S.stderr = ""; S.lastError = ""; S.startedAt = Date.now();
  child.on("exit", (code, signal) => {
    if (S.child === child) {
      S.closeAdapter?.(); S.closeAdapter = null;
      S.child = null; S.rpc = null; S.activeTurn = null;
      S.generation++;
      S.starting = null; S.loadedThreads.clear(); S.operations.clear(); S.compacting.clear();
      S.runningTurns.clear(); S.startingTurns.clear(); S.approvals.clear();
      activityChanged();
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
    if (S.rpc === rpc && S.generation === generation) stopServer();
    throw new Error("Codex 引擎初始化失败：" + errMsg(e));
  }
  assertRpc(rpc, generation);
  await refreshAccount();
  assertRpc(rpc, generation);
  await refreshModels();
  assertRpc(rpc, generation);
  broadcast({ type: "server", state: "ready" });
  return rpc;
}

function ensureRpc() {
  if (S.starting) return S.starting;
  if (S.rpc) return Promise.resolve(S.rpc);
  const starting = startRpc(S.generation).finally(() => {
    if (S.starting === starting) { S.starting = null; activityChanged(); }
  });
  S.starting = starting; activityChanged();
  return starting;
}

function stopServer() {
  const c = S.child;
  if (contextSaveTimer) saveContexts();
  S.closeAdapter?.(); S.closeAdapter = null;
  S.generation++;
  S.starting = null; S.loadedThreads.clear(); S.operations.clear(); S.compacting.clear();
  S.child = null; S.rpc = null; S.activeTurn = null;
  S.runningTurns.clear(); S.startingTurns.clear(); S.approvals.clear();
  activityChanged();
  if (c) { try { c.stdin.end(); } catch {} try { c.kill("SIGTERM"); } catch {} setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 1500).unref(); }
  broadcast({ type: "server", state: "stopped" });
}

process.on("exit", () => { if (contextSaveTimer) saveContexts(); S.closeAdapter?.(); if (S.child) { try { S.child.kill("SIGKILL"); } catch {} } if (proxy) { try { proxy.srv.close(); } catch {} } });

// ── 高级动作 ─────────────────────────────────────────────────────────
async function startThread(cwd) {
  const dir = safeCwd(cwd == null || cwd === "" ? CFG.workspace : cwd);
  if (!dir) throw Object.assign(new Error("项目目录不存在或无法访问，请重新选择目录"), { statusCode: 400 });
  return rpcOperation(async (rpc, check) => {
    const params = {
      cwd: dir,
      modelProvider: connectionStatus().mode === "custom" ? CUSTOM_PROVIDER : "openai",
      ...threadPermissions(),
    };
    if (S.model) params.model = S.model;
    const r = await rpc.request("thread/start", params, 60000);
    check();
    if (r && r.thread) { S.loadedThreads.add(r.thread.id); S.threadCwds.set(r.thread.id, dir); S.activeThread = r.thread; rememberTitle(r.thread); S.activeTurn = null; S.cwd = dir; broadcast({ type: "thread", thread: slimThread(r.thread) }); }
    return r;
  });
}
async function resumeThread(threadId, { select = true } = {}) {
  if (typeof threadId !== "string" || !threadId.trim()) throw Object.assign(new Error("请选择要恢复的任务"), { statusCode: 400 });
  return rpcOperation(async (rpc, check) => {
    const r = await rpc.request("thread/resume", {
      threadId: String(threadId),
      modelProvider: connectionStatus().mode === "custom" ? CUSTOM_PROVIDER : "openai",
      ...(S.model ? { model: S.model } : {}),
      ...threadPermissions(),
    }, 60000);
    check();
    if (r && r.thread) {
      const restored=await readThreadUsage(r.thread.path,path.join(CODEX_HOME,"sessions"),r.thread.id);check();
      if(restored&&(!S.contexts.has(r.thread.id)||restored.updatedAt>S.contexts.get(r.thread.id).updatedAt)){
        S.contexts.set(r.thread.id,restored);saveContexts();
      }
      S.loadedThreads.add(r.thread.id);
      if(r.thread.cwd)S.threadCwds.set(r.thread.id,r.thread.cwd);
      if (select) S.activeThread = r.thread;
      rememberTitle(r.thread);
      // 恢复会话只改变当前视图，不能把正在后台执行的轮次当成结束。
      const running = (r.thread.turns || []).find((t) => t.status === "inProgress" && !S.endedTurns.has(t.id));
      if (running) S.runningTurns.set(r.thread.id, running);
      if (select) { S.activeTurn = S.runningTurns.get(r.thread.id) || null; S.cwd = r.thread.cwd || S.cwd; }
      activityChanged();
      broadcast({ type: "thread", thread: slimThread(r.thread) });
    }
    return r;
  });
}
async function startTurn(text, threadId, references = []) {
  const s = String(text || "");
  if (!s.trim()) throw new Error("消息是空的");
  if (s.length > 200000) throw new Error("消息太长");
  const initial = String(threadId || S.activeThread?.id || "");
  const pendingKey = initial || "@new", generation = S.generation;
  if (S.runningTurns.has(pendingKey) || S.startingTurns.has(pendingKey) || S.compacting.has(pendingKey)) throw new Error("这个任务还在运行，请先停止或等待完成");
  S.startingTurns.add(pendingKey);
  activityChanged();
  try {
    const rpc = await ensureRpc();
    if (generation !== S.generation || S.rpc !== rpc) throw new Error("Codex 引擎已停止，请重新发送");
    if (initial && !S.loadedThreads.has(initial)) await resumeThread(initial, { select: false });
    if (!initial && !S.activeThread) await startThread(S.cwd);
    assertRpc(rpc, generation);
    const target = initial || S.activeThread.id;
    const input = await referenceInput(references, S.threadCwds.get(target) || (S.activeThread?.id === target ? S.activeThread.cwd : null) || S.cwd);
    assertRpc(rpc, generation);
    const permission = PERMISSIONS[S.permissionMode];
    const params = { threadId: target, input: [{ type: "text", text: s }, ...input], approvalPolicy: permission.approvalPolicy, approvalsReviewer: permission.approvalsReviewer, sandboxPolicy: permission.sandboxPolicy };
    if (S.model) params.model = S.model;
    if (S.effort) params.effort = S.effort;
    let r = await rpc.request("turn/start", params, 60000);
    if (generation !== S.generation || S.rpc !== rpc) throw new Error("Codex 引擎已停止，请重新发送");
    if (r?.turn && S.endedTurns.has(r.turn.id)) r = { ...r, turn: { ...r.turn, status: "completed" } };
    if (r && r.turn && r.turn.status === "inProgress") {
      S.runningTurns.set(target, r.turn);
      if (target === S.activeThread?.id) S.activeTurn = r.turn;
    }
    broadcast({ type: "turn", threadId: target, turn: r && r.turn ? { id: r.turn.id, status: r.turn.status } : null });
    return r;
  } finally {
    if (generation === S.generation) { S.startingTurns.delete(pendingKey); activityChanged(); }
  }
}
async function steerTurn(text) {
  if (!S.activeThread || !S.activeTurn) throw new Error("当前没有在跑的轮次");
  const rpc = await ensureRpc();
  return rpc.request("turn/steer", { threadId: S.activeThread.id, expectedTurnId: S.activeTurn.id, input: [{ type: "text", text: String(text || "") }] }, 60000);
}
async function compactThread(threadId) {
  const target = typeof threadId === "string" ? threadId.trim() : "";
  if (!target) throw Object.assign(new Error("请选择要压缩的任务"), { statusCode: 400 });
  if (S.runningTurns.has(target) || S.startingTurns.has(target) || S.compacting.has(target) || [...S.approvals.values()].some(a => a.params?.threadId === target)) throw Object.assign(new Error("请等待当前任务结束后再压缩"), { statusCode: 409 });
  const generation = S.generation;
  S.compacting.add(target); activityChanged();
  try {
    return await rpcOperation(async (rpc, check) => {
      if (!S.loadedThreads.has(target)) await resumeThread(target, { select: false });
      check();
      if (S.runningTurns.has(target) || [...S.approvals.values()].some(a => a.params?.threadId === target)) throw Object.assign(new Error("请等待当前任务结束后再压缩"), { statusCode: 409 });
      const result = await rpc.request("thread/compact/start", { threadId: target }, 60000);
      check();
      return result;
    });
  } catch (error) { if (S.generation === generation) S.compacting.delete(target); activityChanged(); throw error; }
}
async function interruptTurn(threadId) {
  const target = String(threadId || S.activeThread?.id || "");
  const turn = S.runningTurns.get(target);
  if (!turn) throw new Error("当前没有在跑的轮次");
  const rpc = await ensureRpc();
  return rpc.request("turn/interrupt", { threadId: target, turnId: turn.id }, 30000);
}
async function listThreads() {
  const rpc = await ensureRpc();
  const r = await rpc.request("thread/list", { limit: 50 }, 30000);
  const threads = (r && r.data || []).map(slimThread).filter(Boolean);
  for (const t of threads) rememberTitle(t);
  return threads;
}
async function login() {
  if (connectionStatus().mode === "custom") throw new Error("请先切换到 ChatGPT 连接方式");
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
  const rpc = S.rpc;
  if (!rpc) throw new Error("Codex 引擎没有在跑");
  S.approvals.delete(String(id));
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
  activityChanged();
}

function updateSettings(body) {
  const c=connectionStatus(),currentId=c.mode==="custom"?c.providerId:"chatgpt",targetId=body.providerId||currentId;
  const target=targetId==="chatgpt"?null:connectionProfiles().find(p=>p.id===targetId);
  if(targetId!=="chatgpt"&&!target)throw new Error("提供商配置不存在，请刷新后重试");
  const switching=targetId!==currentId,scope=target?.baseUrl||"chatgpt";
  const id=(typeof body.model==="string"?body.model:switching?target?.model||prefs.model||"":S.model)||(target?.model||"");
  if(id.length>200||/[\x00-\x1f\x7f]/.test(id))throw new Error("模型名称无效");
  const previous={...modelSettings(scope,id)};
  if(body.capabilities!==undefined)validateModelSettings(body.capabilities);
  // Validate selections against proposed user declarations, and restore them if
  // the connection/prefs write fails. Public catalog entries never receive keys.
  const same=!switching&&id===S.model;
  const selection={...body,model:id,effort:body.effort??previous.effort??(same?S.effort:""),contextWindow:body.contextWindow??previous.contextWindow??(same?contextOverride():0)};
  const config={...previous,...(body.capabilities||{}),contextWindow:selection.contextWindow,effort:selection.effort};
  validateModelSettings(config);
  if(codexActivity().busy||S.starting)throw Object.assign(new Error("请等待任务结束后再切换模型"),{statusCode:409});
  saveModelSettings(scope,id,config);
  const before=S.models;
  try {
    const models=target?customModels(scope,id):S.models.map(m=>configuredModel(scope,m));
    const selected=models.find(m=>m.id===id||m.model===id);
    if(selection.effort&&(!selected||!selected.supportedReasoningEfforts?.some(e=>e.reasoningEffort===selection.effort)))throw new Error("这个模型不支持所选思考强度");
    if(switching){
      // Validate and save the entire selection in one API operation; the UI never
      // switches a provider first and then tries to repair a failed model save.
      if(target)setConnection({mode:"custom",providerId:targetId,model:id,effort:selection.effort,contextWindow:selection.contextWindow});
      else {
        const next={...prefs,model:id,effort:selection.effort,contextWindow:selection.contextWindow};
        if(!saveState(PREF_FILE,JSON.stringify(next),{mode:0o600}))throw new Error("设置没有保存");
        try{setConnection({mode:"chatgpt"});}catch(error){saveState(PREF_FILE,JSON.stringify(prefs),{mode:0o600});throw error;}
        Object.assign(prefs,next);S.model=id;S.effort=selection.effort;broadcast({type:"status",status:status()});
      }
      return {model:id,effort:selection.effort,contextWindow:selection.contextWindow,status:status()};
    }
    S.models=models;
    const result=applySettings(selection);
    return body.providerId?{...result,status:status()}:result;
  }
  catch(error){saveModelSettings(scope,id,previous,{replace:true});S.models=before;throw error;}
}
function applySettings(body) {
  let model = typeof body.model === "string" ? body.model : S.model;
  const effort = typeof body.effort === "string" ? body.effort : S.effort;
  if (model.length > 200 || effort.length > 40) throw new Error("设置值太长");
  const selected = S.models.find((m) => m.id === model || m.model === model) || (!model ? S.models.find((m) => m.isDefault) || S.models[0] : null);
  if (model && S.models.length && !selected) throw new Error("当前账号不支持这个模型，请刷新模型列表");
  if (effort && selected && !(selected.supportedReasoningEfforts || []).some((x) => x.reasoningEffort === effort)) throw new Error("这个模型不支持所选思考强度");
  const previousWindow = contextOverride();
  const contextWindow = body.contextWindow === undefined ? model === S.model ? previousWindow : 0 : body.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 0 || (contextWindow > 0 && contextWindow < 1024) || contextWindow > 1e9) throw new Error("上下文大小应为 1024 到 1000000000 的整数，留空使用默认值");
  if ((model !== S.model || contextWindow !== previousWindow) && codexActivity().busy) throw Object.assign(new Error("请等待任务结束后再切换模型"), { statusCode: 409 });
  if (connectionStatus().mode === "custom") {
    model = model || selected?.id || connectionStatus().model;
    const changed = model !== connectionStatus().model;
    // The context limit is a process override. Recreate the idle engine so a
    // different model never inherits the previous model's context window.
    if (changed && codexActivity().busy) throw Object.assign(new Error("请等待任务结束后再切换模型"), { statusCode: 409 });
    updateCustomSelection(model, effort, contextWindow);
    if (changed || contextWindow !== previousWindow) stopServer();
    S.models = connectionModels();
  }
  else {
    const next = { ...prefs, model, effort, contextWindow };
    if (!saveState(PREF_FILE, JSON.stringify(next), { mode: 0o600 })) throw new Error("设置没有保存，请检查存储空间后重试");
    Object.assign(prefs, next);
    if (contextWindow !== previousWindow || (model !== S.model && previousWindow)) stopServer();
  }
  S.model = model; S.effort = effort;
  broadcast({ type: "status", status: status() });
  broadcast({ type: "settings", model, effort, contextWindow });
  return { model, effort, contextWindow };
}

function updatePermissions(mode) {
  if (!Object.hasOwn(PERMISSIONS, mode)) throw Object.assign(new Error("无效的权限模式"), { statusCode: 400 });
  if (codexActivity().busy) throw Object.assign(new Error("请等待任务结束后再修改权限"), { statusCode: 409 });
  const next = { ...prefs, permissionMode: mode };
  if (!saveState(PREF_FILE, JSON.stringify(next), { mode: 0o600 })) throw new Error("权限设置没有保存");
  Object.assign(prefs, next); S.permissionMode = mode;
  broadcast({ type: "status", status: status() });
  return status();
}

function setConnection(body) {
  if (codexActivity().busy || S.starting) throw Object.assign(new Error("还有任务在运行，请结束后再切换连接"), { statusCode: 409 });
  const old=connectionStatus(),connection = updateConnection(body);
  if(body.activate===false&&old.mode===connection.mode&&old.providerId===connection.providerId&&body.providerId!==old.providerId){broadcast({type:"status",status:status()});return status();}
  stopServer(); S.account = null; S.models = []; S.activeThread = null;
  S.model = connection.mode === "custom" ? connection.model : prefs.model || "";
  S.effort = connection.mode === "custom" ? connection.effort || "" : prefs.effort || "";
  if (connection.mode === "custom") S.models = connectionModels();
  broadcast({ type: "status", status: status() });
  return status();
}

async function extensions(cwd) {
  const dir = safeCwd(cwd);
  if (!dir) throw new Error("项目目录不存在");
  const rpc = await ensureRpc();
  const [skills, mcp, plugins] = await Promise.allSettled([
    rpc.request("skills/list", { cwds: [dir], forceReload: true }, 30000),
    rpc.request("mcpServerStatus/list", { limit: 100 }, 30000),
    rpc.request("plugin/list", { cwds: [dir], forceRefetch: false, marketplaceKinds: ["local"] }, 30000),
  ]);
  return { cwd: dir, codexHome: CODEX_HOME, configPath: path.join(CODEX_HOME, "config.toml"), agentsPath: path.join(dir, "AGENTS.md"),
    skills: skills.status === "fulfilled" ? skills.value.data || [] : null,
    skillsError: skills.status === "rejected" ? errMsg(skills.reason) : "",
    mcp: mcp.status === "fulfilled" ? mcp.value.data || [] : null,
    mcpNextCursor: mcp.status === "fulfilled" ? mcp.value.nextCursor || null : null,
    mcpError: mcp.status === "rejected" ? errMsg(mcp.reason) : "",
    plugins: plugins.status === "fulfilled" ? (plugins.value.marketplaces || []).flatMap(market => (market.plugins || []).filter(p => p.installed && p.enabled).map(p => ({ id: p.id, name: p.name, displayName: p.interface?.displayName || p.name, path: p.source?.type === "local" ? p.source.path : "" }))) : [],
    pluginsError: plugins.status === "rejected" ? errMsg(plugins.reason) : "" };
}

async function referenceInput(references, cwd) {
  if (!Array.isArray(references) || references.length > 20) throw new Error("每条消息最多引用 20 项");
  if (!references.length) return [];
  const { safeFilePath } = await import("./files.mjs");
  const catalog = references.some(r => ["skill", "plugin", "mcp"].includes(r?.type)) ? await extensions(cwd) : null;
  return references.map(ref => {
    if (!ref || typeof ref.path !== "string" || ref.path.length > 4096) throw new Error("引用无效");
    if (ref.type === "skill") {
      const skill = (catalog.skills || []).flatMap(g => g.skills || []).find(s => s.path === ref.path && s.enabled);
      if (!skill) throw new Error("技能已停用或不在当前项目中，请重新选择");
      return { type: "skill", name: skill.name, path: skill.path };
    }
    if (ref.type === "plugin") {
      const plugin = (catalog.plugins || []).find(p => p.id === ref.path);
      if (!plugin) throw new Error("插件已停用或未安装，请重新选择");
      return { type: "mention", name: plugin.name, path: "plugin://" + plugin.id };
    }
    if (ref.type === "mcp") {
      const server = (catalog.mcp || []).find(s => s.name === ref.path);
      if (!server) throw new Error("MCP 服务已不在清单中");
      return { type: "text", text: "Use the MCP server " + JSON.stringify(server.name) + " for this task when relevant." };
    }
    if (ref.type === "file") {
      const file = safeFilePath(ref.path);
      if (file.error) throw new Error("本地文件无法引用：" + file.error);
      return { type: "text", text: "Referenced local file: " + JSON.stringify(file.file) };
    }
    throw new Error("不支持的引用类型");
  });
}

async function setSkill(cwd, skillPath, enabled) {
  if (typeof skillPath !== "string" || typeof enabled !== "boolean") throw new Error("技能设置无效");
  const list = await extensions(cwd);
  if (!(list.skills || []).some((group) => (group.skills || []).some((s) => s.path === skillPath))) throw new Error("技能已不在当前项目清单中，请刷新");
  const rpc = await ensureRpc();
  return rpc.request("skills/config/write", { path: skillPath, enabled }, 30000);
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
    if (method === "GET" && p === "/api/codex/extensions") return json(res, 200, await extensions(u.searchParams.get("cwd") || S.cwd));
    if (method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "请求体不是 JSON" }); }
      if (p === "/api/codex/install") { startInstall(); return json(res, 200, { ok: true, install: { ...INSTALL } }); }
      if (p === "/api/codex/stop") { stopServer(); return json(res, 200, { ok: true }); }
      if (p === "/api/codex/thread") { const r = await startThread(body.cwd); return json(res, 200, { thread: slimThread(r && r.thread) }); }
      if (p === "/api/codex/open-thread") { const r = await resumeThread(body.threadId); return json(res, 200, { thread: slimThread(r && r.thread) }); }
      if (p === "/api/codex/turn") { const r = await startTurn(body.text, body.threadId, body.references); return json(res, 200, { turn: r && r.turn ? { id: r.turn.id, status: r.turn.status } : null }); }
      if (p === "/api/codex/permissions") return json(res, 200, updatePermissions(body.mode));
      if (p === "/api/codex/steer") { const r = await steerTurn(body.text); return json(res, 200, r || {}); }
      if (p === "/api/codex/interrupt") { const r = await interruptTurn(body.threadId); return json(res, 200, r || {}); }
      if (p === "/api/codex/compact") { await compactThread(body.threadId); return json(res, 200, { ok: true }); }
      if (p === "/api/codex/login") { const r = await login(); return json(res, 200, r || {}); }
      if (p === "/api/codex/login-cancel") { const r = await loginCancel(body.loginId); return json(res, 200, r || {}); }
      if (p === "/api/codex/logout") { const r = await logout(); return json(res, 200, r || {}); }
      if (p === "/api/codex/approve") {
        if (!S.approvals.has(String(body.id))) return json(res, 409, { error: "这条确认已经失效" });
        approve(body.id, body.decision, body.answers); return json(res, 200, { ok: true });
      }
      if (p === "/api/codex/settings") {
        return json(res, 200, updateSettings(body));
      }
      if (p === "/api/codex/connection") return json(res, 200, setConnection(body));
      if(p==="/api/codex/connection/delete"){
        if(codexActivity().busy||S.starting)throw Object.assign(new Error("请等待任务结束后再修改提供商"),{statusCode:409});
        deleteConnectionProfile(body.providerId);broadcast({type:"status",status:status()});return json(res,200,status());
      }
      if(p==="/api/codex/model-catalog"){
        if(typeof body.query!=="string"||body.query.length>200)throw new Error("模型搜索内容过长");
        await refreshModelCatalog();return json(res,200,searchModelCatalog(body.query));
      }
      if(p==="/api/codex/model-metadata"){
        const id=typeof body.model==="string"?body.model.trim():"";
        if(!id||id.length>200||/[\x00-\x1f\x7f]/.test(id))throw new Error("模型名称无效");
        const capabilities=validateModelSettings({referenceId:body.referenceId||null});
        return json(res,200,modelDetails(id,{baseUrl:typeof body.baseUrl==="string"?body.baseUrl:"",referenceId:capabilities.referenceId}));
      }
      if (p === "/api/codex/models") {
        if(S.connectionProbe)return json(res,429,{error:"模型获取正在进行，请稍后重试"});
        const controller=new AbortController();S.connectionProbe=controller;
        const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on("close",cancel);
        try{return json(res,200,await loadModels(body.providerId|| (connectionStatus().mode==="custom"?connectionStatus().providerId:"chatgpt"),{signal:controller.signal}));}
        finally{res.off("close",cancel);if(S.connectionProbe===controller)S.connectionProbe=null;}
      }
      if (p === "/api/codex/connection/models" || p === "/api/codex/connection/test") {
        if (S.connectionProbe) return json(res, 429, { error: "连接检测正在进行，请稍后重试" });
        const controller = new AbortController(); S.connectionProbe = controller;
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", cancel);
        try { return json(res, 200, await (p.endsWith("/models") ? discoverApiModels : testApiConnection)(body, { signal: controller.signal })); }
        finally { res.off("close", cancel); S.connectionProbe = null; }
      }
      if (p === "/api/codex/skill") return json(res, 200, await setSkill(body.cwd, body.path, body.enabled));
      if (p === "/api/codex/refresh") { await refreshAccount(); await refreshModels(); return json(res, 200, status()); }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    log("[codex] " + method + " " + p + " → " + errMsg(e));
    return json(res, e.statusCode || 500, { error: errMsg(e) });
  }
}

// 只供隔离测试注入协议替身，正式网关不暴露内部状态。
export const _codexForTest = LIVE ? null : { S, status, handleNotify, handleRequest, startThread, startTurn, resumeThread, interruptTurn, compactThread, stopServer, approve, refreshModels, loadModels, updateSettings, updatePermissions, referenceInput, setConnection, extensions, setSkill, downloadTo };
