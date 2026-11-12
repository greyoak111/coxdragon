# coxdragon

[![许可](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Android](https://img.shields.io/badge/Android-8.0%2B%20(arm64)-green)](https://developer.android.com)
[![状态](https://img.shields.io/badge/status-early%20alpha-orange)](#状态)

**安卓上的 Codex，带一个图形工作台。** coxdragon 把 OpenAI 官方的 Codex
app-server 放进一个普通安卓应用里，用本机网关把它护住，再把它的 JSON-RPC 事件铺成
聊天式工作区：线程、工具调用、文件改动、命令输出、审批卡片。

它是 **[cccodroid](https://github.com/greyoak111/cccodroid)**（Apache-2.0）的
分支，按共创项目改用 **AGPL-3.0**。安卓外壳、本机网关、终端、文件浏览器和设置来自
上游；Codex 引擎、Codex 页面和 `cox.dragon` 包名是新加的。

> 与 OpenAI、Anthropic 均无隶属或背书关系。Codex 从 OpenAI 官方 Release 下载、原样
> 运行；Claude Code 不随包分发。

---

## 能做什么

- **官方 Codex，原样运行。** 从 `openai/codex` 的 Release 下载
  `codex-app-server`，按钉住的 SHA-256 核对，走文档里的 stdio JSON-RPC 协议
  （`initialize`、`thread/*`、`turn/*`、`account/*`）。
- **ChatGPT 设备码登录。** 不内置任何密钥。界面显示一次性代码，并打开浏览器里的
  验证地址。
- **真正的工作台，不是终端套壳。** 线程列表、流式回复、思考摘要、带实时输出的命令卡、
  补丁卡、MCP 工具卡、计划、模型 / 思考强度选择，以及每个需要确认的命令的审批卡。
- **本地优先。** Codex 以本应用 uid 运行。网关只监听回环，要求每次安装的令牌和
  逐请求 HMAC，没有「一键关闭安全检查」的开关。
- **安卓联网的两关已经补好。** 静态 musl 程序拿到一个只监听回环的 CONNECT 代理
  （随机口令），CA 包来自工具包或系统信任库。不需要 root、VPN 服务或
  `/etc/resolv.conf` 那一套。
- **cccrodroid 的外壳照旧可用。** 前台服务、终端、文件浏览器、文档查看器、Shizuku
  集成、通知和原来的设置页都在。

## 架构

```
┌────────────────────────────────────────────────────────────────────┐
│ 安卓应用（cox.dragon）                                              │
│                                                                    │
│  MainActivity / WebView / 前台服务                                 │
│        │  http://127.0.0.2:<端口>（Cookie + 逐请求 HMAC）            │
│        ▼                                                          │
│  本机网关（Node，只听 127.0.0.1 / 127.0.0.2）                       │
│   ├── /api/codex/*  ──►  codex-app-server（官方静态 musl）          │
│   │                       │ stdio JSON-RPC（一行一条 JSON）          │
│   │                       ├── account/login/start（设备码）          │
│   │                       ├── thread/start, thread/list, resume      │
│   │                       ├── turn/start, turn/steer, interrupt      │
│   │                       └── item/*, turn/*, 审批请求               │
│   ├── 本机 CONNECT 代理（随机端口 + Basic 口令）                     │
│   ├── CA 包（工具包 cert.pem 或系统 cacerts）                        │
│   └── 原有 cccodroid 接口（文件、终端、设置…）                        │
│                                                                    │
│  工作区 ~/workspace  ◄── Codex 在这里读代码、改文件、跑命令          │
└────────────────────────────────────────────────────────────────────┘
```

app-server 的 stdout 按行解析。服务端发起的请求
（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、
`item/permissions/requestApproval`、`item/tool/requestUserInput`、
`mcpServer/elicitation/request`）**不会自动回答**：网关先把它们扣住、显示卡片，
再把用户的选择作为 JSON-RPC 响应发回去。

## 安全边界

这是一个能跑 shell 命令的代理。设计上尽量把这件事摆在明面上：

1. **只有本应用能跟网关说话。** 只监听回环，要求安装级令牌或界面 Cookie，核对
   Host/Origin，并对 App 的每个请求用本次启动派生的 HMAC 签名。别的应用或网页发来
   的请求一律拒绝。
2. **Codex 以本应用 uid 运行。** 没有 root、没有 Shizuku、没有 `su`。安卓应用自己
   能碰到的东西它才能碰到。
3. **审批是明确的。** 线程用 `approvalPolicy: "untrusted"` 启动：只读 / 可信操作可以
   直接跑，其余一律停下问人。界面给「允许一次」「本任务都允许」「拒绝」「拒绝并中止」。
4. **沙箱就是安卓应用沙箱。** 用 `sandbox: "danger-full-access"`，因为多数安卓机型
   不允许 bubblewrap 建用户命名空间（实测报 `Permission denied`）。这是有意的取舍：
   Codex 以本应用 uid 运行，能碰应用能碰的任何文件，**包括应用私有目录里的
   `~/.codex` 凭据——只要你批准了那样的命令**。保护来自审批，不是进程内沙箱；
   每张命令卡都要自己看清楚。
5. **引擎二进制钉死。** 下载的 tar 和解出来的二进制各核一次 SHA-256（常量在
   `gateway/gw/codex.mjs`）；被换过的二进制拒绝运行。
6. **联网辅助只在本机、要口令。** CONNECT 代理绑 `127.0.0.1` 的随机端口，要求随机
   `user:password`，不是给别的应用用的通用代理。

已知的边界见 [SECURITY.md](SECURITY.md)（上游文档；Codex 相关的取舍在本节上面）。

## 状态

早期 alpha。协议和登录链路已经在安卓 17 arm64 真机上对着官方
`codex-app-server 0.166.0` 跑过：

- [x] 包名改成 `cox.dragon`，构建出签名基线 APK
- [x] 下载 / 核对官方 app-server，拉起进程，完成 JSON-RPC 初始化
- [x] 通过本机代理 + CA 包完成 ChatGPT 设备码登录
- [x] `thread/start`、`thread/list`、`thread/resume`、`turn/start`、`turn/interrupt`
- [x] 把 `item/*` / `turn/*` 通知映射到工作台界面
- [x] 审批卡片与 JSON-RPC 应答
- [ ] 给 `cox.dragon` 单独打一版 `devkit-2026.11`（进行中）
- [ ] 用真实 ChatGPT 账号在真机上跑通一整轮
- [ ] targetSdk 36 验证
- [ ] 截图和短视频

在 `cox.dragon` 工具包发布之前，首装还指着上游 cccodroid 的工具包。**不要拿这个组合
干正事**：它的 first-run 脚本里写死了旧包名前缀。第一个公开 APK 之前会把钉子切到
coxdragon 自己的工具包 Release。

## 构建

就是 cccodroid 的构建，换包名、换签名钥匙、换输出名。需要 Android SDK 的
`android.jar`（不随仓库分发）、JDK 17、d8、aapt2 和一个 aarch64 安卓 C 编译器。
在 cccodroid / Termux 设备上，这些大多已经在 `~/.bldtools` 里。

```sh
# 1. 签名钥匙：{"key": "<PEM 私钥>", "cert": "<PEM 证书>"}
#    默认读 ~/.bldtools/coxdragon-release.json。
#    务必离线备份：丢了就没法给已装用户发更新。
export KEY="$HOME/.bldtools/coxdragon-release.json"

# 2. 构建（默认 targetSdk 28）
sh scripts/build.sh
# → dist/coxdragon.apk

# 3. 可选：targetSdk 36 的包（同版本号、同钥匙）
TARGET_SDK=36 sh scripts/build.sh
# 把 dist/coxdragon.apk 移成 dist/coxdragon-36.apk
```

工具包的钉子写在 `devkit-pin.json`，Release 目录写在 `devkit-sources.txt`。
`android/assets/gwpin.json` 从钉住的工具包生成，只为可复现构建；构建缓存
（`devkit/cache`、`devkit-out`、`.cache`、`dist`）都不进 git。

## 首次运行

1. 安装 APK。系统可能要求允许「安装未知应用」。
2. 选工具包来源（GitHub 或镜像）和要装的模块。基础块必装，默认勾选约 330 MB。
3. 应用跑工具包的 first-run，然后提示安装 Codex 引擎（约 84 MB，官方 Release，
   核 SHA-256）。
4. 打开 **Codex** 页 → **登录 ChatGPT** → 在浏览器打开验证地址、输入一次性代码。
   app-server 报成功后卡片自动消失。
5. 输入任务。需要确认的命令会出现在输入框上方。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `gateway/gw/codex.mjs` | Codex 引擎：安装、代理、CA、JSON-RPC、审批、路由 |
| `gateway/web/codex.js` `codex.css` | Codex 工作台页面 |
| `gateway/web/app/` | 原有 cccodroid 单页应用（按文件名拼成 `/app.js`） |
| `android/` | 安卓外壳（Java）、清单、原生小库、预编译加载器 |
| `devkit/` | 工具包构建器与模块清单 |
| `scripts/build.sh` | APK 构建 |
| `docs/upstream/` | 原 cccodroid README，留作署名和构建细节参考 |

## 许可

**GNU Affero 通用公共许可证 v3.0 或更高版本** —— 见 [LICENSE](LICENSE)。

coxdragon 基于 cccodroid（Copyright 2026 greyoak111 及贡献者，Apache-2.0）。
上游许可原文保留在 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)，
[NOTICE](NOTICE) 列出随包第三方组件。因为本项目是 AGPL，若你把修改版作为网络服务
运行，必须向用户提供对应的源码。

对应源码：<https://github.com/greyoak111/coxdragon>

## 参与

这是奔着共创去的项目。问题报告、机型兼容记录、界面补丁、翻译、文档都欢迎。动手前
先看 [CONTRIBUTING.md](CONTRIBUTING.md)；上游的安全规矩仍然适用。凡是改动网关安全
边界的大 PR，请先开 issue 对齐。

## 致谢

- [cccodroid](https://github.com/greyoak111/cccodroid) —— 安卓外壳、网关和工具包
  设计，本项目从它分叉。
- [OpenAI Codex](https://github.com/openai/codex) —— 官方 app-server 与 CLI。
- [Termux](https://termux.dev) —— 组成工具包的软件包。
- [Shizuku](https://shizuku.rikka.app) —— 可选的提权辅助集成。
- 完整的第三方库与许可见上游 README。
