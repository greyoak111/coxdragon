// Refresh the offline metadata snapshot; this never contacts a model provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
process.env.CCAPP_TEST = "1";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "coxdragon-model-catalog-"));
process.env.CCAPP_HOME = temporary;
try {
const { reduceModelCatalog } = await import("../gateway/gw/codex-models.mjs");
const data = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : await (await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30000) })).json();
const target = new URL("../gateway/data/models-dev.json.gz", import.meta.url);
fs.mkdirSync(path.dirname(fileURLToPath(target)), { recursive: true });
fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(reduceModelCatalog(data))));
console.log("Updated offline models.dev capabilities snapshot");
} finally {
  const checked = path.resolve(temporary);
  if (!checked.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(checked).startsWith("coxdragon-model-catalog-")) throw new Error("Unsafe catalog cleanup path");
  fs.rmSync(checked, { recursive: true, force: true });
}
