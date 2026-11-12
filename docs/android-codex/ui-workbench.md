# v0.1.3 会话工作台交接

日期：2026-11-12。开发分支：`ui/chat-workbench`。这是待用户安装验收的预发布版本；没有把手机视觉验收或 targetSdk 36 标为完成。

## 本次交付

- 客户端源码：https://github.com/greyoak111/coxdragon/tree/ui/chat-workbench
- 发布页：https://github.com/greyoak111/coxdragon/releases/tag/v0.1.3
- 组件仓库：https://github.com/greyoak111/coxdragon-components
- APK：`coxdragon-0.1.3-chat-ui.apk`，18.34 MiB，包名 `cox.dragon`，versionCode 4，targetSdk 28。
- SHA256：`6c790612151af55d5f99a45382b740dd62b5e2856ee82868bd7c1c56d08543e2`。
- 正式签名证书 SHA256：`93f4d801b104b160140644b9d13109756d20cf8cc1d875fec58ef93835b2b9fb`。可覆盖相同签名的旧安装。

原有 GitHub 起点为 `14f9bfe`（v0.1.1），手机已安装版本为 0.1.2。为避免把现用引擎降回旧实现，本次从经过正式签名验证的已安装 APK 恢复缺失的网页和网关源码，再合入界面修改。源码中的 542 个对应文件与交付 APK 的资产内容逐字节一致；机器可读记录见 [release-0.1.3.json](release-0.1.3.json)。

安装包以现用 0.1.2 为基底，保留全部原生库、classes.dex 和资源，替换六个界面文件、重建 TAG/FILES 并递增版本后重新签名。这次没有重新编译原生代码；常规源码构建与交付 APK 的 dex 是否逐字节一致尚未验证。

## 已完成的功能和复用

按用户要求，直接克隆 `greyoak111/cccodroid` 到本地相邻目录，核对基线为 `af79e9b`（v0.6.17）。原 `layout.js`、`style.css`、核心 Markdown 和消息视图代码已有共同来源，继续复用现成实现。

- Codex 会话接入原侧栏：手机使用原抽屉，宽屏使用原停靠栏，移除内层重复侧栏。
- 新建和打开会话继续走官方 Codex 线程接口；可以过滤已加载会话的标题、预览和目录。
- 768px 阅读宽度、中性深浅外观、圆角输入区、欢迎页及草稿建议。建议只填入草稿，不自动执行。
- 复用 `01-core.js` 的 `renderMd`、`enhanceMd`、`copyText`、`onCopyBtn`、`onPathLink`：Markdown、公式、高亮、安卓复制回退和本地文件打开。
- 复用 `02-chat-view.js` 的 `actBtn`；回复复制保留原始 Markdown。
- 文件浏览器、查看器、终端、设置、折叠屏分栏、手势和浮层继续使用原实现。
- 现用版已包含的 Codex 修复也已恢复到源码：代码模式宿主下载和哈希核验、自动补齐组件、模型回退及思考档位联动、Codex 账户/引擎状态、隐藏 Claude 专属入口和安装提示。

## 验证记录

- 28 段前端脚本拼接语法通过，Codex 网关和独立前端语法通过。
- 用临时缓存目录的 linkedom 对真实 HTML/脚本检查：单一侧栏、标题转义、大小写不敏感搜索、重复刷新保留欢迎页、建议不发送、线程渲染、复用复制/路径/Markdown 处理器、离页清理均通过。没有增加项目运行依赖；DOM 检查不具备浏览器布局能力。
- `apksigner verify` 通过；签名与原正式证书一致。
- APK 的 552 项应用资产清单、原生库和 dex 内容一致性、下载副本 SHA256 均已核验。
- 最初界面分支的 44 项相关回归通过。合入手机现用版后同一组为 43 通过、1 失败；失败是 A6 仍要求 Claude 的 `/api/status` auth 文案，在原未修改 APK 的前端上同样失败。没有据此倒退 Codex 账户实现。
- 本次远端交接另跑了完整网关测试；结果与失败项见 [validation-0.1.3.md](validation-0.1.3.md)，没有声称全套测试通过。
- 浏览器截图、手机 WebView 视觉/软键盘、真实切会话和后台恢复仍需安装验收；其他语言新增译文暂回落中文，英文已补。

## 接手和复现

本地交互预览（示例数据，不连接账户和引擎）：

```sh
node scripts/preview-codex.mjs
# http://127.0.0.1:8765/
```

常规完整源码构建仍用 `sh scripts/build.sh`，工具需求见仓库 README。界面更新重打包则使用本次新增脚本：

```sh
# 先从上面的 v0.1.3 发布页下载 APK，核对发布的 SHA256。
# 签名文件由维护者自己准备，放在应用私有目录，不能提交到仓库。
BASE_APK=/private/path/coxdragon-0.1.3-chat-ui.apk \
KEY=/private/path/coxdragon-release.json node scripts/package-ui-update.mjs
```

该脚本也接受原 0.1.2 APK，验证基底和钥匙的正式证书后打包。产物在 `dist/`。本地 `.build-ui/`、安装包和签名文件均由 git 忽略；此发布没有上传私钥、账户凭据或会话记录。

## 下一步

1. 用户安装 0.1.3，核对手机竖屏、横屏、键盘弹出、侧栏和宽屏工作区。
2. 验证真实会话的发送、停止、流式工具输出、审批和切后台恢复。
3. 校正旧测试对 Claude/旧产品名称的假设，区分环境限制与功能缺陷；全套检查通过后再考虑稳定版及合并。
4. targetSdk 36 仍单独验收，不从 targetSdk 28 外推结果。
