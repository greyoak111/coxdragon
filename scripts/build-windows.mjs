// Native Windows equivalent of build.sh. Requires Node, JDK 17+ and the SDK/NDK
// versions pinned in .github/workflows/apk.yml. KEY stays outside the source tree.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readZip, writeZipParts, signApk } from "./apklib.mjs";

if (process.argv.includes("--help")) {
  console.log("Set ANDROID_SDK_ROOT, JAVA_HOME and KEY (release key JSON), then run:\n" +
    "  node scripts/build-windows.mjs [--all-targets]\n" +
    "Optional: TARGET_SDK=36, BUILD_TOOLS=35.0.0, PLATFORM=android-35, NDK=27.2.12479018, SRC, DEVKIT_BASES");
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("Use scripts/build.sh on Linux / Android");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, "android");
const build = path.join(android, "build");
const app = path.join(android, "assets", "app");
const native = path.join(android, "nativelib");
const src = process.env.SRC || path.join(root, "gateway");
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (!sdk) throw new Error("Set ANDROID_SDK_ROOT to your Android SDK directory");
const bt = path.join(sdk, "build-tools", process.env.BUILD_TOOLS || "35.0.0");
const ndk = path.join(sdk, "ndk", process.env.NDK || "27.2.12479018", "toolchains", "llvm", "prebuilt", "windows-x86_64");
const jar = path.join(sdk, "platforms", process.env.PLATFORM || "android-35", "android.jar");
const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin") : "";
const java = path.join(javaBin, "java.exe");
const javac = path.join(javaBin, "javac.exe");
const clang = path.join(ndk, "bin", "clang.exe");
const aapt = path.join(bt, "aapt2.exe");
const key = process.env.KEY || path.join(os.homedir(), ".bldtools", "coxdragon-release.json");
if (!fs.existsSync(key)) throw new Error("Signing key JSON not found; set KEY to its path outside the repository");
const target = process.env.TARGET_SDK;
if (target && !/^\d+$/.test(target)) throw new Error("TARGET_SDK must be an API level");
if (target && process.argv.includes("--all-targets")) throw new Error("Choose TARGET_SDK or --all-targets");
const targets = process.argv.includes("--all-targets") ? [undefined, "36"] : [target];
for (const f of [clang, aapt, jar, path.join(bt, "lib", "d8.jar"), path.join(bt, "lib", "apksigner.jar")]) {
  if (!fs.existsSync(f)) throw new Error("Missing build tool: " + f);
}
const run = (exe, args) => execFileSync(exe, args, { cwd: root, stdio: "inherit", windowsHide: true });
const hash = (b, algorithm = "sha256") => crypto.createHash(algorithm).update(b).digest("hex");
const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const mkdir = (d) => fs.mkdirSync(d, { recursive: true });
const textExtensions = new Set([".mjs", ".cjs", ".js", ".html", ".css", ".md", ".json", ".txt", ".svg", ".xml", ".sh", ".map"]);
// A checkout with core.autocrlf=true must still ship Unix shebangs and scripts.
function copy(a, b) {
  if (fs.statSync(a).isDirectory()) {
    mkdir(b);
    for (const n of fs.readdirSync(a)) copy(path.join(a, n), path.join(b, n));
    return;
  }
  mkdir(path.dirname(b));
  let data = fs.readFileSync(a);
  if (textExtensions.has(path.extname(a)) || data.subarray(0, 2).equals(Buffer.from("#!"))) {
    data = Buffer.from(data.toString("utf8").replaceAll("\r\n", "\n"));
  }
  fs.writeFileSync(b, data);
}
const list = (d) => fs.readdirSync(d).sort();
const files = (d, prefix = "") => list(d).flatMap((n) => {
  if (n.startsWith(".")) return [];
  const rel = prefix + n, full = path.join(d, n);
  return fs.statSync(full).isDirectory() ? files(full, rel + "/") : [rel];
});
// Only these generated directories may be recursively removed. Resolve existing
// paths too, so a junction cannot redirect cleanup outside the workspace.
function clean(d) {
  if (![app, native, build].includes(path.resolve(d))) throw new Error("Unexpected cleanup target: " + d);
  if (fs.existsSync(d)) {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(d));
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new Error("Cleanup target escapes workspace: " + d);
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
  mkdir(d);
}
function copyChildren(from, to, filter = () => true) {
  mkdir(to);
  for (const n of list(from).filter(filter)) copy(path.join(from, n), path.join(to, n));
}
// Use javac's and the JVM's argument parsers (D8's own @files do not unquote
// paths). This handles spaces and avoids Windows command length limits.
function argFile(name, args) {
  const f = path.join(build, name);
  fs.writeFileSync(f, args.map((a) => '"' + a.replaceAll("\\", "/").replaceAll('"', '\\"') + '"').join("\n") + "\n");
  return "@" + f;
}

console.log("▸ assets");
clean(app);
for (const n of ["server.mjs", "boot.mjs"]) copy(path.join(src, n), path.join(app, n));
for (const n of ["gw", "archive", "guard"]) copyChildren(path.join(src, n), path.join(app, n), (f) => n !== "gw" || f.endsWith(".mjs"));
copyChildren(path.join(src, "web"), path.join(app, "web"), (n) => !n.includes(".bak"));
for (const n of ["scripts", "bin", "pre"]) copyChildren(path.join(android, "assets", n), path.join(app, n));
copy(path.join(root, "devkit", "pgp.mjs"), path.join(app, "bin", "pgp.mjs"));
copy(path.join(android, "assets", "TOOLS.md"), path.join(app, "TOOLS.md"));
for (const n of ["NOTICE", "LICENSE"]) copy(path.join(root, n), path.join(app, "licenses", n));
copy(path.join(root, "third_party", "shizuku", "LICENSE"), path.join(app, "licenses", "Shizuku-API-LICENSE"));
for (const n of ["COPYING.LIB", "README.md"]) copy(path.join(root, "third_party", "glibc", n), path.join(app, "licenses", "glibc-" + n));
for (const n of ["License.txt", "copying.txt", "unRarLicense.txt", "README.md"]) copy(path.join(root, "third_party", "7zip", n), path.join(app, "licenses", "7zip-" + n));
const sources = path.join(android, "assets", "devkit-sources.txt");
const pinFile = path.join(android, "assets", "devkit-pin.json");
if (process.env.DEVKIT_BASES) {
  fs.writeFileSync(sources, process.env.DEVKIT_BASES.trim().split(/\s+/).join("\n") + "\n");
  run(process.execPath, [path.join(root, "scripts", "pin-devkit.mjs"), fs.readFileSync(sources, "utf8").split(/\r?\n/)[0], pinFile]);
} else {
  copy(path.join(root, "devkit-sources.txt"), sources);
  copy(path.join(root, "devkit-pin.json"), pinFile);
}
const pin = readJSON(pinFile);
if (pin.base !== fs.readFileSync(sources, "utf8").split(/\r?\n/)[0]) throw new Error("Devkit sources and pin disagree");

console.log("▸ native arm64 (NDK)");
clean(native);
const shared = ["-O2", "-shared", "-fPIC", "-nostdlib", "-fno-stack-protector", "-Wl,-z,noexecstack", "-Wl,--hash-style=both"];
const compile = (out, source, flags) => run(clang, ["--target=aarch64-linux-android26", ...flags, "-o", path.join(native, out), path.join(android, "native", source)]);
compile("libccenosys.so", "seccomp-enosys.c", shared);
compile("libccenosysrun.so", "seccomp-enosys-run.c", ["-O2"]);
compile("libccptyhost.so", "ptyhost.c", ["-O2"]);
compile("libccexecshim.so", "exec-shim.c", shared);
compile("libccexecshimb.so", "exec-shim.c", ["-DBIONIC", "-O2", "-shared", "-fPIC", "-fno-stack-protector", "-Wl,-z,noexecstack", "-Wl,--hash-style=both", "-ldl"]);
compile("libccnodump.so", "nodump.c", shared);
const seven = path.join(android, "prebuilt", "libcc7zz.so");
if (hash(fs.readFileSync(seven)) !== fs.readFileSync(seven + ".sha256", "utf8").trim()) throw new Error("7-Zip prebuilt checksum mismatch");
copy(seven, path.join(native, "libcc7zz.so"));
copy(path.join(android, "native", "execpath.cjs"), path.join(app, "lib", "execpath.cjs"));
const tagFiles = ["server.mjs", "boot.mjs", ...["gw", "archive", "guard"].flatMap((d) => files(path.join(app, d)).map((n) => d + "/" + n)), "TOOLS.md",
  ...["web", "scripts", "bin", "pre", "lib"].flatMap((d) => files(path.join(app, d)).sort().map((n) => d + "/" + n))];
const md5 = crypto.createHash("md5");
for (const n of tagFiles) md5.update(fs.readFileSync(path.join(app, n)));
const libs = list(native).filter((n) => /^libcc.*\.so$/.test(n));
for (const n of libs) md5.update(fs.readFileSync(path.join(native, n)));
const tag = md5.digest("hex").slice(0, 12);
fs.writeFileSync(path.join(app, "TAG"), tag + "\n");
fs.writeFileSync(path.join(app, "FILES"), files(app).filter((n) => n !== "FILES").sort().map((n) => hash(fs.readFileSync(path.join(app, n))) + " " + n).join("\n") + "\n");
console.log("  tag " + tag);

console.log("▸ javac + d8");
clean(build);
mkdir(path.join(build, "classes"));
const shizuku = list(path.join(root, "third_party", "shizuku")).filter((n) => n.endsWith(".jar")).map((n) => path.join(root, "third_party", "shizuku", n));
run(javac, [argFile("javac.args", ["-encoding", "UTF-8", "--release", "8", "-nowarn", "-cp", [jar, ...shizuku].join(path.delimiter), "-d", path.join(build, "classes"), ...files(path.join(android, "java")).filter((n) => n.endsWith(".java")).map((n) => path.join(android, "java", n))])]);
run(java, [argFile("d8-java.args", ["-cp", path.join(bt, "lib", "d8.jar"), "com.android.tools.r8.D8", "--release", "--min-api", "26", "--lib", jar, "--output", build, ...files(path.join(build, "classes")).filter((n) => n.endsWith(".class")).map((n) => path.join(build, "classes", n)), ...shizuku])]);

console.log("▸ pinned runtime");
if (!pin.lock || !/^[a-f0-9]{64}$/.test(pin.lock.sha256)) throw new Error("Devkit pin has no valid lock checksum");
const lockFile = path.join(root, "devkit", "cache", `lock-${pin.tag}.json`);
mkdir(path.dirname(lockFile));
if (!fs.existsSync(lockFile)) run("curl.exe", ["-fsSL", "--retry", "3", "--connect-timeout", "20", "--max-time", "180", "-o", lockFile, pin.base + "devkit.lock.json"]);
if (hash(fs.readFileSync(lockFile)) !== pin.lock.sha256) {
  fs.rmSync(lockFile);
  throw new Error("Devkit lock checksum mismatch (removed cached file)");
}
const libDir = path.join(build, "lib", "arm64-v8a");
mkdir(libDir);
for (const n of libs) copy(path.join(native, n), path.join(libDir, n));
const devkit = path.join(root, "devkit", "devkit.mjs");
run(process.execPath, [devkit, "gwpin", "--pin", pinFile, "--target", pin.target, "--vendored", path.join(android, "prebuilt"), "--out", path.join(android, "assets", "gwpin.json")]);
run(process.execPath, [devkit, "ldso", "--lock", lockFile, "--target", pin.target, "--release", pin.base, "--vendored", path.join(android, "prebuilt", "glibc"), "--out", path.join(libDir, "libldlinux.so")]);

console.log("▸ aapt2 + signature");
run(aapt, ["compile", "--dir", path.join(android, "res"), "-o", path.join(build, "res.zip")]);
const packagedAssets = path.join(build, "assets");
copy(path.join(android, "assets"), packagedAssets);
mkdir(path.join(root, "dist"));
for (const target of targets) {
  let manifest = path.join(android, "AndroidManifest.xml");
  if (target) {
    const xml = fs.readFileSync(manifest, "utf8");
    if (!/android:targetSdkVersion="\d+"/.test(xml)) throw new Error("Manifest has no targetSdkVersion");
    manifest = path.join(build, "AndroidManifest.xml");
    fs.writeFileSync(manifest, xml.replace(/android:targetSdkVersion="\d+"/, `android:targetSdkVersion="${target}"`));
  }
  const unsigned = path.join(build, "unsigned" + (target ? "-" + target : "") + ".apk");
  run(aapt, ["link", "-o", unsigned, "-I", jar, "--manifest", manifest, "-A", packagedAssets, path.join(build, "res.zip")]);
  // Windows aapt2 can emit backslashes in asset entry names. Android AssetManager
  // needs ZIP-standard slashes; normalize before the FILES check and signing.
  const entries = readZip(fs.readFileSync(unsigned));
  if (entries.some((e) => e.name.includes("\\"))) {
    for (const e of entries) e.name = e.name.replaceAll("\\", "/");
    if (new Set(entries.map((e) => e.name)).size !== entries.length) throw new Error("Duplicate APK entries after path normalization");
    const parts = writeZipParts(entries);
    fs.writeFileSync(unsigned, Buffer.concat([parts.local, parts.cd, parts.eocd]));
  }
  const names = new Set(entries.map((e) => e.name));
  const missing = fs.readFileSync(path.join(app, "FILES"), "utf8").trim().split("\n").map((l) => "assets/app/" + l.slice(65)).filter((n) => !names.has(n));
  if (missing.length) throw new Error("Assets missing from APK: " + missing.slice(0, 5).join(", "));
  const out = path.join(root, "dist", "coxdragon" + (target ? "-" + target : "") + ".apk");
  const result = signApk(unsigned, out, [
    { name: "classes.dex", data: fs.readFileSync(path.join(build, "classes.dex")), method: 8 },
    ...["libldlinux.so", ...libs].map((n) => ({ name: "lib/arm64-v8a/" + n, data: fs.readFileSync(path.join(libDir, n)), method: 0 }))
  ], key);
  run(java, ["-jar", path.join(bt, "lib", "apksigner.jar"), "verify", "--verbose", "--print-certs", out]);
  const expected = new crypto.X509Certificate(readJSON(key).cert).fingerprint256.replaceAll(":", "").toLowerCase();
  console.log(`✓ ${out} · ${(result.size / 1048576).toFixed(2)} MiB · certificate SHA-256 ${expected}`);
}
