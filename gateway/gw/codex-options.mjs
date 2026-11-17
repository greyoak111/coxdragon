import path from "node:path";
import { CFG } from "./config.mjs";
import { loadState, writeAtomic } from "./statefile.mjs";

const FILE = path.join(CFG.home, "coxdragon-codex-options.json");
export const OPTION_DEFAULTS = Object.freeze({
  web_search: "", model_reasoning_summary: "", model_verbosity: "",
  model_auto_compact_token_limit: 0, developer_instructions: "", compact_prompt: "",
});
const CHOICES = {
  web_search: ["", "disabled", "cached", "indexed", "live"],
  model_reasoning_summary: ["", "auto", "concise", "detailed", "none"],
  model_verbosity: ["", "low", "medium", "high"],
};
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
export function validateCodexOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Codex 设置无效");
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(OPTION_DEFAULTS, key)) throw invalid("不支持的 Codex 设置：" + key);
    if (CHOICES[key]) {
      if (!CHOICES[key].includes(entry)) throw invalid("Codex 选项值无效：" + key);
    } else if (key === "model_auto_compact_token_limit") {
      if (!Number.isSafeInteger(entry) || entry < 0 || entry > 1e9 || entry > 0 && entry < 1024) throw invalid("自动压缩阈值应为 1024 到 1000000000 的整数，留空使用默认值");
    } else if (typeof entry !== "string" || entry.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(entry)) {
      throw invalid("指令必须为不超过 16000 字的文本");
    }
    next[key] = entry;
  }
  return next;
}
const saved = loadState(FILE, { max: 256 << 10, shape: v => { try { return validateCodexOptions(v); } catch { return undefined; } } }).data;
let options = { ...OPTION_DEFAULTS, ...saved };
export function codexOptions() { return { ...options }; }
export function saveCodexOptions(value) {
  const next = { ...options, ...validateCodexOptions(value) };
  if (!writeAtomic(FILE, JSON.stringify(next), { mode: 0o600 })) throw new Error("Codex 设置没有保存，请检查存储空间后重试");
  options = next;
  return codexOptions();
}
export function codexOverrides(connection = {}) {
  const result = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== "" && value !== 0));
  // The Chat adapter cannot provide OpenAI's hosted web-search tool.
  if (connection.mode === "custom" && connection.wireApi === "chat") result.web_search = "disabled";
  return result;
}
export function codexOptionArgs(connection) {
  return Object.entries(codexOverrides(connection)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
export function publicEffectiveOptions(config) {
  return Object.fromEntries(Object.keys(OPTION_DEFAULTS).map(key => [key, config?.[key] ?? null]));
}
