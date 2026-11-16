# 模型设置与上下文

统计行位于输入框下方，显示当前提供商、模型、思考强度、最近匹配轮次的输出速度、当前会话累计输入/输出 token，以及累计缓存命中率。窄屏可横向滚动。速度从首个输出事件到完成估算，不包含首字等待；接口不返回的字段保持未知。

模型面板打开后先显示本地目录，再主动刷新。ChatGPT 使用 Codex `model/list` 分页；第三方使用保存的地址与凭据请求 `/models`，失败仍可手动填写 ID。元数据来源依次为用户设置、接口声明、精确匹配的 models.dev 离线目录；不会根据名称猜测多模态或思考强度。缺少元数据的模型可在“模型能力配置”中按服务商文档手动指定。

上下文上限与思考强度按提供商地址、模型 ID 保存，切换后恢复。上下文设置留空表示自动。更改模型或上限时重建空闲引擎，下一次发送先恢复会话，不自动重放任务。运行中禁止改变连接或模型。提供商配置中的密钥留在私有文件，不进入模型目录和状态响应。

上下文占用取 `thread/tokenUsage/updated.tokenUsage.last.totalTokens`，累计计费取 `total`。打开历史时从引擎返回的会话文件恢复 token_count；读取限于 sessions 目录，校验 session_meta 身份，只读文件头和最多 4 MiB 尾部，不读取消息正文来估算 token。压缩后的旧占用失效，等待下一次引擎报告；跨模型/提供商的旧上限也不直接沿用。

## 开源参考

本轮阅读了 OpenClaw 的 MIT 开源实现，参考提交 `ec025eba2df15ab949239fa17dfd99ac4286b50c`，按当前网关架构独立实现：

- [上下文设置优先级](https://github.com/openclaw/openclaw/blob/ec025eba2df15ab949239fa17dfd99ac4286b50c/src/agents/model-context-window.ts)：明确选择优先于目录默认值。
- [Codex 用量投影](https://github.com/openclaw/openclaw/blob/ec025eba2df15ab949239fa17dfd99ac4286b50c/extensions/codex/src/app-server/event-projector-usage.ts)：区分最近请求上下文与累计计费；缺失字段不当作 0；压缩后失效。
- [模型目录](https://github.com/openclaw/openclaw/blob/ec025eba2df15ab949239fa17dfd99ac4286b50c/extensions/codex/src/app-server/model-catalog.ts)：主动发现真实模型，隔离异步读取与过期状态。
- [模型切换后的上下文处理](https://github.com/openclaw/openclaw/blob/ec025eba2df15ab949239fa17dfd99ac4286b50c/src/gateway/sessions-patch-context-window.ts)：模型选择变更后不复用旧预算。

models.dev 保留随包许可证及离线快照。Chat Completions 的用量依赖服务商支持 `stream_options.include_usage`；手动声明能力不会让不支持该能力的上游接口自动获得支持。

## 26.1.2 验证

- 60 项协议/元数据/历史读取回归通过。浏览器回归覆盖 320、390、820、1440px、中英文、自动刷新、迟到结果保留草稿、未知模型手动能力、提供商切换，以及统计行处于输入框下方且正文无重复指标。
- 固定 `codex-app-server 0.166.0` 在 Windows 和小米 M2012K11AC / Android 13 运行，连接隔离的本地合成接口，验证原生 usage、缓存命中、jsonl 恢复和压缩；不使用真实服务商凭据。
- 手机已覆盖安装签名版 `26.1.2`，资源标识 `72ccb499e289`。实际 CodeFlow 短请求返回 `CONTEXT_USAGE_OK`；输入约 8.6k、输出 7 token、缓存命中率 97.9%。切换到其他聊天再返回，原会话上下文仍可见。手动上限 64000 保存、重新打开保留，验证后恢复自动。
- CodeFlow 当前 `/models` 仅提供该模型 ID，没有上下文/强度/多模态声明，models.dev 也未精确匹配；面板保留未知并允许手动指定。用量弹层的 `258400 · Codex` 是引擎报告的当前预算，不能视为服务商声明的模型硬上限。
- [GitHub 检查](https://github.com/leemwood/coxdragon/actions/runs/43936258184)包含 Linux 网关全量测试、真实引擎、浏览器和 Java 检查。标准版和 targetSdk 36 版均已本地构建并核对签名与资源；targetSdk 36 版未在该手机安装。
- 强制停止应用再启动的冷启动命令被自动审批以 `blocked by policy` 拒绝，本轮使用正常打开面板和重新打开历史完成验证。
