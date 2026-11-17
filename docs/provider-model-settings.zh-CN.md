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
