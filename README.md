# coxdragon

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Android](https://img.shields.io/badge/Android-8.0%2B%20(arm64)-green)](https://developer.android.com)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange)](#status)

**Codex on Android, with a graphical workbench.** coxdragon runs OpenAI's official
Codex app-server inside an ordinary Android app, keeps it behind a local authenticated
gateway, and turns its JSON-RPC events into a chat-style workspace: threads, tool calls,
file changes, command output, and approval cards.

It is a fork of **[cccodroid](https://github.com/greyoak111/cccodroid)**, released
under **Apache-2.0**. The Android shell, local gateway, terminal, file browser and
settings come from that work; the Codex engine, the Codex page and the `cox.dragon`
package are new.

> Not affiliated with or endorsed by OpenAI or Anthropic. Codex is downloaded from
> OpenAI's official release and run unmodified. Claude Code is not bundled.

---

## What it does

- **Official Codex, unmodified.** Downloads `codex-app-server` from the
  `openai/codex` release, verifies the pinned SHA-256, and speaks the documented
  stdio JSON-RPC protocol (`initialize`, `thread/*`, `turn/*`, `account/*`).
- **ChatGPT device-code login.** No API key is embedded. The app shows the one-time
  code and opens the verification URL in your browser.
- **A real workbench, not a terminal wrapper.** Thread list, streaming agent messages,
  reasoning summaries, shell cards with live output, patch cards, MCP tool cards,
  plans, model/reasoning-effort selection, and an approval card for every command
  that needs one.
- **Local-first.** The Codex process runs as the app's uid. The gateway only listens on
  loopback, requires a per-install token and a per-request HMAC, and has no global
  "disable checks" switch.
- **Android networking handled.** The static musl binary gets a loopback CONNECT proxy
  (with a random password) and a CA bundle built from the devkit or the system trust
  store. No root, no VPN service, no `/etc/resolv.conf` hacks.
- **The cccodroid shell comes along.** Foreground service, terminal, file browser,
  document viewer, Shizuku integration, notifications, and the existing settings pages
  are still there.

## Components

Optional tools (GitHub CLI, document conversion, circuit simulators, local model
runners, …) come from the separate
[coxdragon-components](https://github.com/greyoak111/coxdragon-components) market.
Recipes are built against this repository's devkit base and published with a signed
index; coxdragon does not read the cccodroid market.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Android app (cox.dragon)                                           │
│                                                                    │
│  MainActivity / WebView / foreground service                      │
│        │  http://127.0.0.2:<port>  (cookie + per-request HMAC)     │
│        ▼                                                          │
│  local gateway (Node, 127.0.0.1 + 127.0.0.2 only)                 │
│   ├── /api/codex/*  ──►  codex-app-server (official static musl)   │
│   │                       │ stdio JSON-RPC (one JSON per line)     │
│   │                       ├── account/login/start (device code)    │
│   │                       ├── thread/start, thread/list, resume    │
│   │                       ├── turn/start, turn/steer, interrupt    │
│   │                       └── item/*, turn/*, approval requests    │
│   ├── local CONNECT proxy (random port + Basic auth)               │
│   ├── CA bundle (devkit cert.pem or system cacerts)                │
│   └── existing cccodroid APIs (files, terminal, settings, …)       │
│                                                                    │
│  workspace ~/workspace  ◄── Codex reads/writes/runs commands here  │
└────────────────────────────────────────────────────────────────────┘
```

The app-server's stdout is parsed line by line. Server-initiated requests
(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`) are **not** answered automatically: the gateway
holds them, shows a card, and sends the user's decision back as the JSON-RPC response.

## Security model

This is an agent that can run shell commands. The design tries to make that visible
instead of hiding it:

1. **Only the app can talk to the gateway.** It binds loopback, requires the
   per-install token or the UI cookie, validates Host/Origin, and signs each app
   request with a boot-scoped HMAC. Requests from other apps or web pages are rejected.
2. **Codex runs as the app uid.** No root, no Shizuku, no `su`. It can only reach what
   the Android app itself can reach.
3. **Approvals are explicit.** Threads are started with
   `approvalPolicy: "untrusted"`: read-only/trusted operations may run, everything else
   stops and asks. The UI offers *allow once*, *allow for this task*, *deny*, and
   *deny and stop*.
4. **The sandbox is the Android app sandbox.** `sandbox: "danger-full-access"` is used
   because bubblewrap cannot create user namespaces on most Android devices (on the
   test device it fails with `Permission denied`). The trade-off is deliberate: Codex
   runs as the app uid and may touch any file the app can touch, **including the
   app's private `~/.codex` credentials, if you approve such a command**. The approval
   gate is the protection, not an in-process sandbox. Read the command on every card.
5. **The engine binary is pinned.** The tar and the extracted binary are both checked
   against SHA-256 constants in `gateway/gw/codex.mjs`. A modified binary is refused.
6. **The network helper is local and authenticated.** The CONNECT proxy binds
   `127.0.0.1` on a random port and requires a random `user:password`. It is not a
   general-purpose proxy for other apps.

Known limitations are listed in [SECURITY.md](SECURITY.md) (upstream document; the
Codex-specific section is at the top of this README).

## Privacy & data protection

See **[PRIVACY.md](PRIVACY.md)** for the full breakdown. coxdragon has **no user accounts, no backend server, no cloud chat sync, and zero first-party telemetry or proprietary analytics SDKs** — every control below can be verified directly in the source tree:

- **Zero telemetry, zero external CDNs & upstream CLI boundaries**:
  - No persistent install ID (`iid`), no usage or crash uploads, and no Google Play Services, ML Kit, Firebase, Sentry, or ad SDKs; all UI scripts and fonts ship offline in [`gateway/web/vendor/`](gateway/web/vendor/).
  - Official `codex-app-server` (Apache-2.0) is verified against pinned archive and binary SHA-256 hashes in [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs) (`CODEX`, `verifyBin`); for the optional Claude Code path, [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs) (`claudeEnv`) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`.
- **Credential isolation, local usage & scrubbed diagnostics**:
  - `android:allowBackup="false"` in [`android/AndroidManifest.xml`](android/AndroidManifest.xml) keeps threads, settings, and keys inside `/data/data/cox.dragon/files/home/` (including `~/.codex`) and out of Android cloud backups.
  - ChatGPT sign-in runs through the official `account/login/start` device-code flow with zero embedded keys ([`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)); third-party API keys live in `0600` private files read via `apiKeyHelper` rather than child environment variables ([`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)).
  - The gateway binds loopback `127.0.0.2` (UI) and `127.0.0.1` only, requiring a per-install token, Host/Origin checks, and boot-scoped single-use HMAC signatures ([`gateway/gw/access.mjs`](gateway/gw/access.mjs), [`android/java/cox/dragon/Events.java`](android/java/cox/dragon/Events.java)).
  - Usage stats read local session files only with zero network requests ([`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)); diagnostic zips scrub keys, tokens, emails, and user prompts locally before invoking the system share sheet and exclude transcripts ([`android/java/cox/dragon/Share.java`](android/java/cox/dragon/Share.java) `bundleLogs`); GitHub feedback pre-fills a `greyoak111/coxdragon` browser URL only when you tap the button ([`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`).
- **Complete outbound network inventory & switches** (aside from commands you explicitly approve in chats/terminals):

| Purpose | Default & Switch | Destinations | Trust Anchor & Source |
|---|---|---|---|
| Model inference & sign-in | When you chat or sign in | OpenAI official endpoints (via `codex-app-server`) or your custom third-party endpoint | [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs), [`gateway/gw/providers.mjs`](gateway/gw/providers.mjs) |
| Automatic update checks & verified list | On (updates every 6h, verified list every 3h); turn off both in **Settings → Updates → Automatic updates** | `api.github.com` (`greyoak111/coxdragon`), `raw.githubusercontent.com`, `downloads.claude.ai`, npm mirrors | APK signing cert + SHA-256; pinned SHA-256 / `ed25519` for devkit; dual SHA-256 for Codex; `ed25519` `.sig` for verified list ([`android/java/cox/dragon/Updater.java`](android/java/cox/dragon/Updater.java) `AUTO_EVERY`, [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/ccverified.mjs`](gateway/gw/ccverified.mjs) `refreshVerified`) |
| Signed maintainer notices (every 3h) | On; turn off in **Settings → Updates → Maintainer notices** | `raw.githubusercontent.com/greyoak111/coxdragon` (static `GET`, no device parameters) | Pinned `ed25519` public key detached `.sig` ([`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`) |
| Third-party GitHub proxy (`gh-proxy.com`) | **Off by default**; opt in via **Settings → Updates → GitHub third-party proxy fallback** | `gh-proxy.com` (external public proxy; sees your IP and target URL if enabled) | Pinned SHA-256 and signatures still enforced ([`android/java/cox/dragon/Installer.java`](android/java/cox/dragon/Installer.java) `ghProxyEnabled`, [`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`, [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)) |
| Toolkit / Codex engine / component downloads | First-run setup or tapping Install | GitHub Releases (`coxdragon`, `coxdragon-components`, `openai/codex`), Termux & university mirrors | Pinned SHA-256, Termux PGP signature, or `ed25519` index signature ([`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/components.mjs`](gateway/gw/components.mjs), [`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)) |

- **Permission minimization & protected-app screen blocking**:
  - Never requests `CAMERA`, `RECORD_AUDIO`, `ACCESS_*_LOCATION`, contacts, SMS, call logs, `READ_CALENDAR`, `PACKAGE_USAGE_STATS`, `NotificationListenerService`, or `MediaProjection`; see [docs/permissions.md](docs/permissions.md).
  - Device tools and accessibility are off by default, gated by lock-screen check ([`android/java/cox/dragon/Consent.java`](android/java/cox/dragon/Consent.java)) and a foreground native dialog ([`android/java/cox/dragon/DeviceTools.java`](android/java/cox/dragon/DeviceTools.java)), auto-disable after 10 minutes of inactivity in the default "Auto (on demand)" mode ([`android/java/cox/dragon/A11y.java`](android/java/cox/dragon/A11y.java) `scheduleIdle`), strip `isPassword()` text, **hard-block active banking, Alipay/UnionPay/wallets, 2FA authenticators, password managers, and system permission controllers on the Accessibility channel** ([`android/java/cox/dragon/A11y.java`](android/java/cox/dragon/A11y.java) `isProtectedPackage`), start Codex threads under `approvalPolicy: "untrusted"`, and enforce an in-memory `PreToolUse` hook ([`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)) on the Claude path.
  - **Custom third-party endpoints**: Prompts, code, and tool outputs sent to any model endpoint are governed by that operator's privacy policy — never use untrusted third-party endpoints for sensitive secrets or personal data.

## Status

Early alpha. The protocol and login path have been exercised against the official
`codex-app-server 0.166.0` on an Android 17 arm64 device:

- [x] rename the package to `cox.dragon`, build a signed baseline APK
- [x] download/verify the official app-server, spawn it, initialize JSON-RPC
- [x] ChatGPT device-code login through the local proxy + CA bundle
- [x] `thread/start`, `thread/list`, `thread/resume`, `turn/start`, `turn/interrupt`
- [x] map `item/*` / `turn/*` notifications into the workbench UI
- [x] approval cards and JSON-RPC responses
- [x] a dedicated `devkit-2026.11.12` build for `cox.dragon`
- [x] a separate `coxdragon-components` market (recipes, built packages, signed index)
- [ ] a real end-to-end turn with a logged-in ChatGPT account on device
- [ ] targetSdk 36 validation
- [ ] screenshots and a short video

First install uses the `devkit-2026.11.12` release published from this repository.
Components come from the separate `coxdragon-components` market, built against the
same devkit base; the cccodroid market is not used.

## Build

The build is the cccodroid build with a different package, signing key and output
name. It needs an Android SDK `android.jar` (not redistributed), JDK 17, d8, aapt2
and an aarch64 Android C compiler. On a cccodroid/Termux device most of these are
already in `~/.bldtools`.

```sh
# 1. signing key: {"key": "<PEM private key>", "cert": "<PEM certificate>"}
#    The default is ~/.bldtools/coxdragon-release.json.
#    Back it up offline: losing it means existing users cannot update.
export KEY="$HOME/.bldtools/coxdragon-release.json"

# 2. build (targetSdk 28 by default)
sh scripts/build.sh
# → dist/coxdragon.apk

# 3. optional: targetSdk 36 build (same version code, same key)
TARGET_SDK=36 sh scripts/build.sh
# → move dist/coxdragon.apk to dist/coxdragon-36.apk
```

The devkit pin lives in `devkit-pin.json`; `devkit-sources.txt` names the release
directory. `android/assets/gwpin.json` is generated from the pinned devkit and is
checked into the build only for reproducibility. Build caches (`devkit/cache`,
`devkit-out`, `.cache`, `dist`) are ignored by git.

## First run

1. Install the APK. Android may ask for permission to install unknown apps.
2. Choose where to get the development toolkit (GitHub or a mirror) and which modules
   to install. The base module is required; the default selection is about 330 MB.
3. The app runs the devkit's first-run scripts, then asks you to install the Codex
   engine (about 84 MB, official release, SHA-256 verified).
4. Open the **Codex** page → **登录 ChatGPT** → open the verification URL and enter
   the one-time code. The card disappears when the app-server reports success.
5. Type a task. Commands that need approval appear above the input box.

## Repository layout

| Path | What |
|---|---|
| `gateway/gw/codex.mjs` | Codex engine: install, proxy, CA, JSON-RPC, approvals, routes |
| `gateway/web/codex.js` `codex.css` | the Codex workbench page |
| `gateway/web/app/` | the existing cccodroid SPA (segments concatenated into `/app.js`) |
| `android/` | Android shell (Java), manifest, native helpers, prebuilt loader |
| `devkit/` | devkit builder and module manifest |
| `scripts/build.sh` | APK build |
| `docs/upstream/` | the original cccodroid README, kept for attribution and build details |

## License

coxdragon itself is released under the **[Apache License 2.0](LICENSE)** (see also [NOTICE](NOTICE); previously published `v0.1.0` / `v0.1.1` release binaries remain under the AGPL-3.0 terms they shipped with).

- **OpenAI Codex**: fetched from the official `openai/codex` release (Apache-2.0) against pinned SHA-256 hashes; not bundled in the APK.
- **Toolchain & bundled LGPL libraries**: toolchain packages come from the official Termux repositories with per-package licenses recorded in `devkit.lock.json` / `SBOM.tsv`. Source-archiving tooling for the bundled glibc loader ([third_party/glibc/README.md](third_party/glibc/README.md)), 7-Zip 26.06 ([third_party/7zip/README.md](third_party/7zip/README.md)), and copyleft toolchain packages is provided in [`devkit/archive-sources.mjs`](devkit/archive-sources.mjs); complete Corresponding Source is provided upon written request (for example in Issues) for at least three years from each binary release.

## Contributing

This is meant to be a co-creation project. Bug reports, device compatibility notes,
UI patches, translations and documentation are all welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first; the upstream security rules still apply.
For anything that changes the gateway's security boundary, open an issue before a
large PR.

## Credits

- [cccodroid](https://github.com/greyoak111/cccodroid) — the Android shell, gateway
  and devkit design this project is forked from.
- [OpenAI Codex](https://github.com/openai/codex) — the official app-server and CLI.
- [Termux](https://termux.dev) — the packages that make up the devkit.
- [Shizuku](https://shizuku.rikka.app) — the optional privileged helper integration.
- The upstream README keeps the full list of third-party libraries and licenses.
