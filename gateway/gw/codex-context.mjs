// Restore engine-reported usage only. Never tokenize visible chat or sum billing
// totals to infer the active context. Reads are bounded and stay in sessions/.
import fs from "node:fs/promises";
import path from "node:path";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function normalizeTokenUsage(usage, snake = false) {
  if (!usage || typeof usage !== "object") return null;
  const fields = { totalTokens: "total_tokens", inputTokens: "input_tokens", outputTokens: "output_tokens", cachedInputTokens: "cached_input_tokens", reasoningOutputTokens: "reasoning_output_tokens" };
  const result = Object.fromEntries(Object.entries(fields).map(([key, wire]) => [key, count(usage[snake ? wire : key])]));
  if (result.totalTokens == null && result.inputTokens != null && result.outputTokens != null) result.totalTokens = result.inputTokens + result.outputTokens;
  return result.totalTokens == null ? null : result;
}

export async function readThreadUsage(file, sessionsRoot, threadId) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  let handle;
  try {
    const [root, resolved] = await Promise.all([fs.realpath(sessionsRoot), fs.realpath(file)]);
    if (!resolved.startsWith(root + path.sep)) return null;
    handle = await fs.open(resolved, "r");
    const stat = await handle.stat(); if (!stat.isFile()) return null;
    // Validate the header even when the usage record is in a large file's tail.
    const header=Buffer.alloc(Math.min(stat.size,64<<10));
    const headerRead=await handle.read(header,0,header.length,0);
    let identity,provider="";
    for(const line of header.subarray(0,headerRead.bytesRead).toString("utf8").split("\n")){
      try{const entry=JSON.parse(line);if(entry.type==="session_meta"){identity=entry.payload?.id;provider=entry.payload?.model_provider||"";break;}}catch{}
    }
    if(identity!==threadId)return null;
    const size = Math.min(stat.size, 4 << 20), offset = stat.size - size;
    const data = Buffer.alloc(size); const read=await handle.read(data, 0, size, offset);
    const lines = data.subarray(0,read.bytesRead).toString("utf8").split("\n"); if (offset) lines.shift();
    let result = null, model = "";
    for (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const p = entry.payload;
      if (entry.type === "session_meta") { identity = p?.id; provider = p?.model_provider || ""; }
      if (identity && identity !== threadId) return null;
      if (entry.type === "turn_context") model = p?.model || model;
      if (entry.type === "compacted" && result) {result.stale = true;result.updatedAt=Date.parse(entry.timestamp)||stat.mtimeMs;}
      if (entry.type !== "event_msg" || p?.type !== "token_count" || !p.info) continue;
      const last = normalizeTokenUsage(p.info.last_token_usage, true);
      if (!last) continue;
      result = { last, total: normalizeTokenUsage(p.info.total_token_usage, true), modelContextWindow: count(p.info.model_context_window) || null,
        model, modelProvider: provider, source: "history", stale: false, updatedAt: Date.parse(entry.timestamp) || stat.mtimeMs };
    }
    return result;
  } catch { return null; }
  finally { await handle?.close(); }
}
