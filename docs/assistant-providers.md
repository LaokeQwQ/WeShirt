# 洗衣助手接口与运行限制

Web 和原生安卓共用 `/api/assistant/*`，主应用仍使用钉钉登录。AI 配置仅总管可改，普通管理员按权限只读；读取配置返回 `keyConfigured`，不会返回密钥。旧配置未显式保存的新字段使用默认值，旧的显式每日、分钟额度继续保留。

## 模型与协议

`GET/PATCH /api/admin/assistant` 使用以下字段：

| 字段 | 说明 |
| --- | --- |
| `protocol` | `responses`、`chat-completions`、`anthropic` |
| `endpoint` | 公网 HTTPS 基础地址或完整接口，按协议自动切换路径 |
| `model` | 模型 ID，可手填 |
| `apiKey` / `clearKey` | 替换或清除服务端密钥，空字符串保留 |
| `reasoningMode` | `auto`、`off`、`on`；自动模式不给未知模型附加思考参数 |
| `reasoningEffort` | `auto/none/minimal/low/medium/high/xhigh/max`，受模型能力约束 |
| `thinkingMode` | Anthropic 的 `auto/adaptive/budget` |
| `modelCapabilities` | 归一化的 `reasoning`、`effortLevels`、`thinkingModes`、`contextWindow` |
| `dailyLimit` | 默认1000，范围1–10000，按北京时间重置，按用户提问计数 |
| `minuteLimit` | 默认30，范围1–30，每一次模型请求计数，含工具续问及失败尝试 |
| `promptProfiles` / `activePromptId` | 平台默认模板及当前默认，最多8套，每套名称40字、内容6000字 |

`POST /api/admin/assistant/models` 接收临时的 `{protocol, endpoint, apiKey?}`，不保存配置，留空密钥复用现有服务端密钥。最多8秒、3页、300个模型；失败时应保留输入并允许手填。请求禁止重定向，响应受大小限制，公网地址校验与聊天一致。返回 `{models:[{id,name,capabilities}],manualSupported:true}`。上游未声明能力时只推断已知模型的常用能力，其余模型保持未知，管理员可依据供应商文档明确开启。

三套适配器分别维护 Responses `function_call_output`、Chat Completions `tool_call_id`、Anthropic `tool_result`，不会相互混用。Anthropic 使用服务端 `x-api-key`，OpenAI 兼容协议使用 Bearer；所有凭据只随请求发送给所配置端点。不会把推理文本显示为回答。

## 个人提示词与上下文

`GET /api/assistant/preferences` 返回当前账号的 `{promptProfiles,activePromptId,customized}`，初次读取继承平台默认。`PATCH` 可修改模板或切换当前模板，`{reset:true}` 删除个人副本并恢复默认；不接受用户 ID 或楼栋参数。修改仅影响当前用户，平台只读边界独立保留，提示词不能授予工具写权限。删除账号时一并清理个人模板。

历史保留14天、最多256条，每条不超过6000字。每次请求采用128000 UTF-8字节作为保守 token 上界，给系统提示、工具定义、工具结果与输出预留空间。达到预算时提取较早用户问题的短片段，并保留最近轮次原文；这是有损提取压缩，不会生成虚构摘要，也不复用旧的机器状态。响应的 `context.compressed` 用于显示压缩提示，`estimatedTokensUpperBound` 是保守上界，不是供应商精确计费 token 数。

Skills 默认可用，MCP 默认仅暴露 `get_machine_status` 白名单，不接受任意服务器、URL、用户或楼栋。所有状态通过服务端账号绑定楼栋实时读取，不返回占用人的资料，也不提供登记、预约、推送或修改数据工具。

## 并发与部署

生产复用已配置的 `mobile:limit:*` 原子存储：分钟请求额度采用 CAS，所有实例共享；按用户设置有期限的聊天租约，防止同时写聊天历史。配额或租约核验失败返回503，拒绝继续发送上游请求。最多3次模型请求/问题，所有请求仍受30/min共同限制。单实例开发环境未配置原子存储时沿用本地锁与存储额度，无法提供跨实例一致性。

本次无需新的原子存储命名空间。若同时部署临时管理员口令功能，仍应先按 [临时口令文档](admin-access-codes.md) 更新 `weshirt-mobile-store`，再发布应用。

协议依据：[OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[OpenAI Models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Anthropic Models](https://platform.claude.com/docs/en/api/models/list)。兼容端点的可选参数仍应以其自己的模型文档为准。
