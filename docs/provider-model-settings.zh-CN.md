# 提供商与模型设置（26.1.3）

输入框左侧固定显示“模型设置”；提供商、模型名和强度只在输入框下方的统计行显示。打开模型面板可以切换提供商和模型、设置上下文与强度，也可以进入完整提供商设置。

提供商页面显示已保存配置及当前使用状态。新增配置可填写名称、API 地址、协议和密钥；支持无需密钥的本地接口。地址会去掉粘贴的 `/responses`、`/chat/completions`、`/models` 后缀。自动协议需测试确认，也可直接手选；测试会发送短模型请求。

“获取模型”只生成候选列表。勾选后点“加入所选模型”，或手动填写模型 ID 并加入。每个模型可设置显示名称、上下文、输入能力、可用思考强度与默认强度；模型目录中可编辑、移除及指定默认模型。接口返回列表不会删掉手动配置的模型。

“仅保存”新增或编辑其他提供商时保留当前连接、引擎和聊天；修改当前正在使用的配置会在空闲时应用。“保存并使用 API”保存并切换。运行中禁止切换配置。当前提供商需先切换再删除；删除配置保留聊天。最多 20 个提供商，每个提供商最多 100 个配置模型；相同地址允许保存不同凭据，模型能力设置仍按地址和模型 ID 共享。

## 能力来源与回退

1. 用户手动配置。
2. 服务商或 Codex 明确声明，包括空强度列表与关闭思考。
3. models.dev 精确匹配或用户明确选择的能力模板。

服务商 `/models` 失败仍可获取本地目录能力。随包快照保证离线可用，公开目录最多等待 4 秒刷新，不传服务商密钥。能力库可按 ID、名称或服务商搜索，最多显示 60 项；同名模型存在多份不同声明时，需要选择与接口一致的模板。模板不会替换发送给接口的模型 ID，也不会覆盖接口已明确声明的能力。“自动匹配”可清除映射。目录提供预算或开关但没有强度枚举时，不编造 low/high 等参数。

模型模板、手动设置和默认选择持久保存；失败保存恢复原设置。目录将来移除模板时，其他手动设置仍保留。配置能力不会改变上游接口的实际实现。

## DeepSeek Harness 参考

阅读 MIT 开源项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，参考提交 `39163dd30f703a79079e2d2446545cff3c453738`，按本项目网关架构独立实现：

- [ProviderEditor](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-settings-models/src/client/ProviderEditor.tsx)：提供商卡片、未保存配置探测与密钥留空保留。
- [ModelListEditor](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-settings-models/src/client/ModelListEditor.tsx) 与 [useModelRows](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-settings-models/src/client/useModelRows.ts)：候选与配置分开、显式加入、逐模型能力配置、保留手动条目。
- [ModelReasoningEfforts](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx)：思考强度属于模型能力，不在整个提供商上统一假定。

## 验证

- `node scripts/test-codex-engine.mjs`：66 项通过，包含发现失败的 models.dev 回退、模板映射/重启/重置、接口声明优先、多模型配置、仅保存保留引擎与聊天、失败完整回滚。
- `node scripts/test-codex-process.mjs`：固定 Codex 0.166.0 进程连接隔离的本地合成接口，验证真实请求、用量、压缩、强度与审批；不使用真实模型。
- `node scripts/test-codex-ui.mjs --screenshots`：真实浏览器覆盖 320/390/820/1440px、中英文，包含候选显式导入/移除、模板保持模型 ID、默认模型、仅保存、重新打开与删除。

26.1.3 标准版已安装至小米 M2012K11AC / Android 13。读回手机已安装 APK 的 SHA-256 为 `da92dec73a362d1a01ff5e83095a473822fdf76144dab7276eaefa52af5401c6`，与本地最终包一致；资源标识 `fc157930e425`。标准版和 targetSdk 36 版均完成签名、版本和逐文件资源校验。targetSdk 36 版未安装到该手机。

本轮真实引擎测试运行在 Windows，使用隔离的合成服务；浏览器回归使用协议替身。ADB 启动应用的命令被自动审批以 `blocked by policy` 拒绝，已请求用户手动打开应用。最终版尚未完成手机 UI 与真实 CodeFlow 请求验证，不能将安装成功当作真机功能验收。

完整 [CI](https://github.com/leemwood/coxdragon/actions/runs/43989011452)已全部通过，包括 Linux 全量网关、固定引擎、浏览器、Java 和 APK 构建。首轮全量测试发现旧 HEAD 测试夹具启动时 `EADDRINUSE`；现仅对明确端口冲突换端口重试，其余启动错误继续报错。
