# Privacy & Data Protection

English | [中文](PRIVACY.zh-CN.md)

coxdragon has no user accounts, no backend application server, no cloud chat sync, and zero first-party telemetry or analytics. This document explains what stays on your phone, every outbound network request the app or gateway can make, how to turn each one off, and where to verify the implementation in the source code.

## 1. Zero Telemetry & Local Data Storage

- **No first-party telemetry or proprietary analytics SDKs**: The app collects no usage statistics, generates no persistent install ID (`iid`), uploads no automatic crash reports, and bundles no Google Play Services, ML Kit, Firebase, Sentry, or ad SDKs. All UI scripts and fonts ([`gateway/web/vendor/`](gateway/web/vendor/)) are bundled offline with zero external CDN requests.
- **Upstream CLI boundaries**:
  - Official `codex-app-server` (Apache-2.0, from `openai/codex` Releases) is verified in [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs) against pinned archive and binary SHA-256 hashes before running unmodified, talking to OpenAI over a `127.0.0.1` loopback CONNECT proxy protected by a random Basic password.
  - For the optional Claude Code path, [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs) (`claudeEnv`) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"` to suppress non-essential telemetry and background auto-updater traffic.
- **Credentials and transcripts stay in private storage**:
  - `android:allowBackup="false"` is set in [`android/AndroidManifest.xml`](android/AndroidManifest.xml); threads, API keys, and login credentials live under `/data/data/cox.dragon/files/home/` (including `~/.codex`) and are excluded from Android cloud backups.
  - ChatGPT sign-in uses the official `account/login/start` device-code flow in your system browser with zero embedded keys ([`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)); Claude API keys live in `0600` private files read via `apiKeyHelper` rather than child process environment variables ([`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)).
- **Local-only usage & scrubbed diagnostics**:
  - The Usage tab computes counts from local session files only with zero network traffic ([`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)).
  - "Bundle diagnostics" scrubs keys, tokens, email addresses, and user message bodies locally before handing the zip to the system share sheet, and excludes conversation transcripts ([`android/java/cox/dragon/Share.java`](android/java/cox/dragon/Share.java) `bundleLogs`).
  - "Report on GitHub" reads device/ROM properties only when you tap the button to pre-fill a `greyoak111/coxdragon` browser URL for your review ([`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`).

## 2. Complete Outbound Network Inventory & Switches

Apart from commands you explicitly approve in chats/terminals, the app and gateway only ever make the following network requests:

| Purpose | Default & Switch | Destinations | What Is Sent | Verification & Source |
|---|---|---|---|---|
| **Model inference & sign-in** | Triggered when you chat or sign in | OpenAI's official endpoints (via `codex-app-server`) or your custom compatible / third-party endpoint | Prompts, tool outputs, and the credentials for that endpoint | [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs), [`gateway/gw/providers.mjs`](gateway/gw/providers.mjs) |
| **Automatic update checks & verified list** | On by default (updates every 6h, signed verified/bad-version list every 3h); turn off both in **Settings → Updates → Automatic updates** | `api.github.com` (`greyoak111/coxdragon`), `raw.githubusercontent.com`, `downloads.claude.ai`, npm mirrors | Plain HTTPS `GET` (no device fingerprint or account data) | APK signing cert + SHA-256; pinned SHA-256 / `ed25519` for devkit; dual pinned SHA-256 for Codex; `ed25519` `.sig` for verified list ([`android/java/cox/dragon/Updater.java`](android/java/cox/dragon/Updater.java), [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/ccverified.mjs`](gateway/gw/ccverified.mjs) `refreshVerified`) |
| **Signed maintainer notices** | On by default (every 3h); turn off in **Settings → Updates → Maintainer notices** (without disabling known-bad update blocks) | `raw.githubusercontent.com/greyoak111/coxdragon/main/notices/notices.json` | Static `GET` with no device parameters (zero requests when switched off) | Verified against pinned `ed25519` public key `.sig` ([`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`) |
| **Third-party GitHub proxy (`gh-proxy.com`)** | **Off by default**; used only if you enable **Settings → Updates → GitHub third-party proxy fallback** and official hosts fail | `gh-proxy.com` (external public proxy) | Your connection IP and target GitHub Release URL | Downloaded bytes are still verified against pinned SHA-256 and signatures ([`android/java/cox/dragon/Installer.java`](android/java/cox/dragon/Installer.java) `ghProxyEnabled`, [`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`, [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)) |
| **On-demand toolkit / Codex engine / component downloads** | First-run setup or when you tap Install in Workbench / Extensions | GitHub Releases (`greyoak111/coxdragon`, `greyoak111/coxdragon-components`, `openai/codex`), Termux & university mirrors | Standard HTTPS file downloads | Pinned SHA-256, Termux PGP signature, or `ed25519` index signature ([`gateway/gw/codex.mjs`](gateway/gw/codex.mjs), [`gateway/gw/components.mjs`](gateway/gw/components.mjs), [`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)) |

Turning off both **Automatic updates** and **Maintainer notices** in **Settings → Updates** stops all periodic background update and notice polling (note: if a legacy installed Claude Code binary lacks a local signed manifest, `gateway/gw/devside.mjs` performs a one-time official manifest verification).

## 3. Android Permission Minimization & Protected-App Guardrails

- **Never requested**: Camera (`CAMERA`), microphone (`RECORD_AUDIO`), coarse/fine/background location (`ACCESS_*_LOCATION`), contacts, SMS, call logs, calendar (`READ_CALENDAR`), app usage stats (`PACKAGE_USAGE_STATS`), notification listener (`NotificationListenerService`), and screen recording projection (`MediaProjection`).
- **Layered guardrails on Device Tools & Accessibility**:
  1. Off by default; enabling requires lock-screen attestation ([`Consent.java`](android/java/cox/dragon/Consent.java)) and a foreground native confirmation dialog ([`DeviceTools.java`](android/java/cox/dragon/DeviceTools.java));
  2. In the default "Auto (on demand)" mode, auto-disables itself via `disableSelf()` after inactivity (10 minutes by default, [`A11y.java`](android/java/cox/dragon/A11y.java) `scheduleIdle`; "Always on" stays active until changed) — never auto-revives behind your back;
  3. Strips `isPassword()` fields and **hard-blocks banking, payment/wallet, 2FA authenticator, password manager, and system permission-controller active windows on the Accessibility channel** (`A11y.isProtectedPackage`) from reading, screenshots, and gestures;
  4. Starts Codex threads with `approvalPolicy: "untrusted"` ([`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)) so non-read-only commands pause for explicit UI card approval, and enforces an in-memory `PreToolUse` hook ([`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)) on the Claude path.

## 4. Third-Party Model Providers & Custom Endpoints

Prompts, workspace files, screenshots, or UI trees sent to a model provider (OpenAI, Anthropic, or any custom third-party endpoint you configure) are processed under that provider's own privacy policy. Operators of custom third-party endpoints can inspect traffic, keys, and code passing through them — never send sensitive secrets or personal data to untrusted third-party endpoints.
