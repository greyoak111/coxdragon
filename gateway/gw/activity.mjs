import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { writeAtomic } from "./statefile.mjs";
import { guarded } from "./crashguard.mjs";

// 有任务在跑时落一个标记文件：cccodroid 的冻结检测只把「跑任务时被冻」算数 ——
// 空闲时被厂商冻结器冻住无害，以前每次都记，设置页的提醒就老是弹
const RUN_FLAG = path.join(CFG.home, ".run-active");
const RUN_PID = String(process.pid);
const sources = new Set();
let wantOn = false;    // 想要的状态
let flagOn = null;     // 上一次确认生效的状态：写失败时与 wantOn 不同，靠定时器重试
let flagTimer = null;
let flagTries = 0;

/** 标记文件的主人还活着吗。pid 被复用成别的进程时也当活着：宁可当「有任务」，也别把另一个网关的标记删了 */
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/** 删标记。只删自己的，或主人已经不在了的残留 —— 另一个还活着的网关（开发时手起第二个、热替换的交接间隙）
 *  写的标记不能碰：删了它，界面一划走外壳就把正在跑任务的服务停了（0.6.9 审计 13-03） */
function dropFlag() {
  let pid = "";
  try { pid = fs.readFileSync(RUN_FLAG, "utf8").trim(); } catch { return true; }   // 本来就没有
  if (pid !== RUN_PID) {
    const n = /^\d+$/.test(pid) ? Number(pid) : 0;
    if (n > 0 && n !== process.pid && ownerAlive(n)) return true;
  }
  try { fs.rmSync(RUN_FLAG, { force: true }); return true; } catch { return false; }
}

function syncFlag() {
  flagTimer = null;
  const want = wantOn;
  const ok = want ? writeAtomic(RUN_FLAG, RUN_PID, { mode: 0o600 }) : dropFlag();
  if (ok) { flagOn = want; flagTries = 0; return; }
  // 写不上（存储满、home 暂时不可写）：开始跑时没写上，界面一划走服务就停；跑完没删掉，服务永远不退出。
  // 退避重试到写成为止，状态又变了就按新的来（0.6.9 审计 13-03）
  flagOn = null;
  const ms = Math.min(30000, 500 * (1 << Math.min(flagTries++, 6)));
  flagTimer = setTimeout(guarded("同步 .run-active", syncFlag), ms);
}

export const runFlag = (on, source = "legacy") => {
  if (on) sources.add(source); else sources.delete(source);
  on = sources.size > 0;
  if (on === wantOn && flagTimer) return;   // 同一状态的重试已经排着，别每次调用都立刻重来
  wantOn = on;
  if (flagOn === wantOn && !flagTimer) return;
  if (flagTimer) { clearTimeout(flagTimer); flagTimer = null; }
  syncFlag();
};
// 启动时清掉上一次进程留下的残留（它已经不在了）；主人还活着的留着
runFlag(false);


export const activityBusy = () => sources.size > 0;
