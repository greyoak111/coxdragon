# 隐私与数据保护说明

[English](PRIVACY.md) | 中文

coxdragon 没有用户账号体系、没有后端业务服务器、没有对话云同步，也没有任何形式的第一方遥测统计。本页逐项说明哪些数据留在你的手机上、应用与网关在什么条件下会联网访问哪些外部地址、怎么逐项关掉它们，并给出对应的源码位置供核查。

## 1. 零遥测与本地数据存储

- **零第一方遥测与闭源统计 SDK**：应用不包含任何使用统计上报、持久化设备实例 ID（`iid`）、崩溃自动上传，也未集成 Google Play Services、ML Kit、Firebase、Sentry 等任何闭源统计或广告 SDK。界面所用的全部脚本与字体（[`gateway/web/vendor/`](gateway/web/vendor/)）均随包离线内置，不请求任何外部 CDN。
- **上游 CLI 进程边界**：
  - 官方 `codex-app-server`（Apache-2.0，取自 `openai/codex` Release）在 [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs) 中按钉死的归档与二进制双层 SHA-256 校验后原样运行，仅通过绑定 `127.0.0.1` 且带随机 Basic 口令的本机 CONNECT 代理访问 OpenAI 接口。
  - 可选的 Claude Code 路径在 [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)（`claudeEnv`）中注入 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`，抑制非必要遥测与后台自更新请求。
- **凭据与会话只留本机私有目录**：
  - 应用声明 `android:allowBackup="false"`（[`android/AndroidManifest.xml`](android/AndroidManifest.xml)），线程记录、API 密钥与登录凭据存放在应用私有目录 `/data/data/cox.dragon/files/home/`（含 `~/.codex`）下，不进系统云备份。
  - ChatGPT 登录采用官方 `account/login/start` 设备码流程，在系统浏览器完成验证，网关不内嵌任何密钥（[`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)）；Claude API Key 经 `0600` 私有文件与 `apiKeyHelper` 按需读取，不放进子进程环境变量（[`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)）。
- **本地用量与诊断脱敏**：
  - 「用量」页只读取本机私有目录下的会话文件统计次数与 Token，零网络请求（[`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)）。
  - 「打包诊断」在本地生成压缩包并交给系统分享面板前，会先抹除密钥、令牌、邮箱以及你发给模型的消息正文，且不包含会话记录（[`android/java/cox/dragon/Share.java`](android/java/cox/dragon/Share.java) `bundleLogs`）。
  - 「到 GitHub 反馈」仅在你主动点击按钮时读取机型与自检摘要拼成 `greyoak111/coxdragon` 浏览器预填链接，由你亲眼过目后自行决定是否提交（[`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`）。

## 2. 出站网络请求全量清单与控制开关

除你在终端或对话里主动批准模型执行的联网命令外，应用与网关自身可能发起的网络请求只有以下几类：

| 用途 | 默认状态与控制开关 | 目标地址 | 发送了什么 | 校验与源码位置 |
|---|---|---|---|---|
| **模型推理与账户登录** | 你发消息或登录时触发 | OpenAI 官方接口（经 `codex-app-server`）或你自行配置的兼容接口 / 第三方调用地址 | 你的提示词、工具返回结果及该接口对应的认证凭据 | [`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)、[`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)、[`gateway/gw/providers.mjs`](gateway/gw/providers.mjs) |
| **自动检查更新** | 默认开启（每 6 小时）；可在 **设置 → 更新 → 自动更新** 关闭 | `api.github.com`（`greyoak111/coxdragon`）、`downloads.claude.ai`、npm 镜像 | 标准 HTTPS `GET`（不含任何设备指纹或账号信息） | APK 验签名证书 + SHA-256；工具包验钉死 SHA-256 / `ed25519` 签名；Codex 验钉死双层 SHA-256（[`android/java/cox/dragon/Updater.java`](android/java/cox/dragon/Updater.java)、[`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)） |
| **维护者远程公告** | 默认开启（每 3 小时）；可在 **设置 → 更新 → 接收维护公告** 彻底关闭 | `raw.githubusercontent.com/greyoak111/coxdragon/main/notices/notices.json` | 纯静态 `GET`（不带任何本机参数；关闭后零请求） | 强制核验内置 `ed25519` 公钥分离签名 `.sig`（[`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`） |
| **GitHub 第三方代理兜底** | **默认关闭**；仅在你主动开启 **设置 → 更新 → GitHub 第三方代理兜底** 且官方源失败时启用 | `gh-proxy.com`（外部第三方公共代理） | 下载请求的公网连接 IP 与目标 GitHub Release URL（开启前请知悉对方无隐私契约） | 下载产物仍强制核对钉死 SHA-256 与签名（[`android/java/cox/dragon/Installer.java`](android/java/cox/dragon/Installer.java) `ghProxyEnabled`、[`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`、[`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)） |
| **工具包 / Codex 引擎 / 组件按需下载** | 首次安装或你在工作台/扩展页点击安装时触发 | GitHub Releases（`greyoak111/coxdragon`、`greyoak111/coxdragon-components`、`openai/codex`）、Termux 官方及高校镜像 | 标准文件下载请求 | 全部核对钉死 SHA-256、Termux PGP 签名或 `ed25519` 索引签名（[`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)、[`gateway/gw/components.mjs`](gateway/gw/components.mjs)、[`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)） |

如果你希望后台完全不向 GitHub 更新源发起轮询，只需在 **设置 → 更新** 中同时关掉「自动更新」与「接收维护公告」。

## 3. 手机权限边界与敏感界面硬隔离

- **绝不申请的权限**：不申请相机（`CAMERA`）、麦克风（`RECORD_AUDIO`）、粗略或后台定位（`ACCESS_*_LOCATION`）、通讯录、短信、通话记录、日历（`READ_CALENDAR`）、应用使用统计（`PACKAGE_USAGE_STATS`）、通知栏监听（`NotificationListenerService`）或实时录屏投影（`MediaProjection`）。
- **设备工具与无障碍多重护栏**：
  1. 默认全关；开启需通过系统锁屏验证（[`Consent.java`](android/java/cox/dragon/Consent.java)）及应用前台原生确认框（[`DeviceTools.java`](android/java/cox/dragon/DeviceTools.java)）；
  2. 默认「用时自动开」在空闲 10 分钟后自动调用 `disableSelf()` 关闭无障碍服务（[`A11y.java`](android/java/cox/dragon/A11y.java) `scheduleIdle`），绝不后台驻留强行复活；
  3. 遇到密码框（`isPassword()`）自动剥离文本与描述；遇到支付宝、云闪付、手机银行、2FA 动态口令应用、密码管理器及系统权限控制器（`A11y.isProtectedPackage`）**硬性拒绝读屏、截屏与手势操作**；
  4. Codex 线程默认以 `approvalPolicy: "untrusted"` 启动（[`gateway/gw/codex.mjs`](gateway/gw/codex.mjs)），非只读命令一律挂起等待你在界面卡片确认；Claude 路径同步挂载内存态 `PreToolUse` 钩子（[`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)）。

## 4. 第三方模型服务商与第三方调用风险提示

当你将消息、代码文件、截图或无障碍读取的界面文本发送给所配置的模型服务商（包括 OpenAI、Anthropic 等官方接口，或你自行填写的任意第三方调用接口）时，这些内容会直接发往该服务商处理并受其隐私政策约束。若使用来路不明的第三方调用端点，对方运营者完全可以看到经过的 API Key、代码与对话内容——请切勿在不可信的第三方调用上处理敏感私密数据。
