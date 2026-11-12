# v0.1.3 验证记录

日期：2026-11-12，执行环境：未 root 安卓 arm64，应用私有工具链。

## 已通过

- `node scripts/appjs.mjs --check`：28 段、17709 行前端脚本语法通过。
- `node --check gateway/gw/codex.mjs`、`node --check scripts/package-ui-update.mjs`：通过。
- 临时 linkedom DOM 交互检查：单一侧栏、转义、搜索、欢迎页刷新、建议草稿、线程渲染、继承的复制/路径/Markdown 回调和离页清理通过。未添加项目依赖。
- `sh scripts/java-tests.sh`：Ed25519 向量、PrivRules、KeyAttest 通过。没有 android.jar，WhatsNewPickTest 及依赖它的后续安卓类测试未运行。
- `apksigner verify`：APK v2 签名通过，正式证书指纹匹配。
- APK 552 项应用资产清单、542 项对应源码、原生库/dex 保留和下载副本 SHA256 检查通过。
- 已从原安装 APK 的 DEX 静态字段确认 `Env.PORT=8891`，源码同值对齐。

## 网关完整回归

命令：`node scripts/test.mjs`。完整运行结束：1556 项，1548 通过，3 失败，5 跳过，用时约 669 秒。该次运行在 MCP 修复前完成；修复后另跑 8 项专项测试和 DOM 交互检查，均通过。

完整回归的失败项：

- A6 195-G.3：旧源码锚点仍要求 Claude 的 `/api/status` auth 文案。原已安装 APK 的未修改前端同样失败；现用实现按 `/api/codex/status` 显示账户。
- U.6：预置第三方厂商的流式补尾断言失败，尚未定位。
- 195-G.6：浏览器 403/foreign 提示的旧源码断言失败，尚未定位。

这不是全套测试通过的声明。未将旧断言删除或放宽来掩盖失败。

## 安装验收

待用户检查：手机 WebView 排版、软键盘、真实发送/停止/审批/流式输出、切会话和切后台恢复。targetSdk 36 没有发布或通过验收。

## MCP 修复后的补充检查（0.1.4）

`node scripts/test.mjs codex-elicitation a0610-f1-frontend a0610-main-static`：29 项全部通过（其中 MCP 专项 8 项）。DOM 交互检查覆盖实际 MCP 表单提交、false/0 保留、同时出现多卡的草稿保留、HTTP 失败重试、requestId 清理、URL 打开不自动接受和危险协议拦截。0.1.4 APK 签名、553 项资产和 543 项源码对应校验通过。
