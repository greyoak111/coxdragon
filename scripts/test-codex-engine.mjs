// Cross-platform Codex protocol and shared Android activity marker checks.
// No CLI binary, account, external service or real project is accessed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "coxdragon-codex-test-"));
const home = path.join(temporary, "home"), workspace = path.join(temporary, "workspace");
fs.mkdirSync(home); fs.mkdirSync(workspace);
const prefix = path.join(temporary, "usr"); fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
const runtime = path.join(temporary, "runtime"); fs.mkdirSync(runtime);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CODEX_|CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
Object.assign(env, { CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: workspace, CCAPP_RUNTIME: runtime,
  CCAPP_LOG: path.join(temporary, "gateway.log"), CCAPP_NO_BRIDGE: "1", CCAPP_PREFIX: prefix });
const child = spawn(process.execPath, ["--test", "--test-concurrency=1",
  "gateway/tests/codex.test.mjs", "gateway/tests/codex-api.test.mjs", "gateway/tests/codex-models.test.mjs", "gateway/tests/codex-context.test.mjs", "gateway/tests/codex-options.test.mjs", "gateway/tests/a0610-j2-runflag.test.mjs"], { env, stdio: "inherit", cwd: root });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.on("error", (e) => { console.error(e.message); process.exitCode = 1; });
child.on("close", (code) => {
  if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temporary).startsWith("coxdragon-codex-test-")) throw new Error("Unsafe test cleanup path");
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
