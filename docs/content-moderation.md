# CloudBase 内容审核

开启审核后，个人上传头像、频道上传头像以及公开、楼栋和机器讨论中的文本，先交给腾讯云数据万象审核。未通过或服务不可用时，原头像、资料、留言和通知保持原状。现有头像、预设头像及服务端获取的钉钉头像沿用原流程。已开启审核的环境，个人头像只能上传文件或使用现有的钉钉头像入口。聊天附件与私聊未接入这条审核流程。

## 同步模式

在 CloudBase 云存储或腾讯云数据万象控制台绑定一个同地域 COS 桶，开通图文审核。按需要分别配置图片、文本策略。

在 EdgeOne Pages 服务端环境或 Node 服务端设置以下变量。子账号凭据仅授予指定桶的 `ci:CreateAuditingPictureJob` 与 `ci:CreateAuditingTextJob` 权限。请按环境设置成本限额和监控，凭据放在服务端配置。

| 变量 | 值 |
| --- | --- |
| `MODERATION_MODE` | `sync`。默认是 `off` |
| `MODERATION_COS_BUCKET` | 带 APPID 后缀的桶名 |
| `MODERATION_COS_REGION` | 桶的地域 |
| `MODERATION_COS_SECRET_ID`、`MODERATION_COS_SECRET_KEY` | 服务端 CAM 凭据 |
| `MODERATION_COS_SESSION_TOKEN` | 可选，和临时凭据同时配置 |
| `MODERATION_IMAGE_BIZ_TYPE`、`MODERATION_TEXT_BIZ_TYPE` | 可选，图片和文本各自的审核策略 |

同步调用使用实际上传的图片字节和待发布的规范化文字。审核通过才会继续原发布逻辑，腾讯返回疑似或违规时，客户端提示用户修改后再提交。此模式没有腾讯回调。

## 异步回调模式

如果需要腾讯回调，配置好独立私有审核桶后选择 `MODERATION_MODE=async`。

1. 使用未启用版本控制的审核桶，启用私有 ACL。在 `moderation/pending/` 前缀设置一日过期生命周期规则。这个前缀仅用于审核，开启自动上传审核会产生重复任务。授予服务端仅向该前缀执行 `cos:PutObject` 的权限，要求禁止覆盖。按腾讯云授权说明只给 CI 审核角色读取该前缀，必要时对该角色授予 `cam:PassRole`。两类任务查询还需要 `ci:DescribeAuditingPictureJob`、`ci:DescribeAuditingTextJob`。
2. 更新并验证 CloudBase 的后台原子存储函数。异步关联记录通过现有私有 CloudBase PostgreSQL 桥的 `mobile:moderation:` 键保存，一小时后过期，记录不含待审核原文和图片。桥与服务端需要同步升级，无新增表。
3. 设 `MODERATION_CALLBACK_URL` 为实际站点的 `https://站点/api/content-review/callback`。设独立随机 `MODERATION_CALLBACK_SECRET`，长度 32–128 个可打印 ASCII 字符。应用给每次异步任务生成专属回调 URL，腾讯 CI 使用 Detail JSON 通知。入口的访问日志应遮蔽 URL 查询参数。
4. 首次提交时，用户会收到「内容正在审核，请稍后重新提交相同内容」。回调只确认已存在的审核任务。服务端校验回调凭据和对应对象，再调用腾讯云查询结果。通过后，由原用户重新提交同一内容，原有权限、禁言和附件检查仍会执行。回调延迟时，重试也可以在间隔后查询原任务。

正式启用前，用测试账号分别验证正常头像和留言、审核拒绝、回调伪造和重复通知、审核服务故障。核对 CI 请求日志与应用事件编号。应用业务日志不记录审核原文、头像字节或回调凭据。

参考 [CloudBase 云存储与数据万象](https://tcb.cloud.tencent.com/blog/2026/06/29/cloud-storage-ci)、[文本同步审核](https://cloud.tencent.com/document/api/460/56285)、[图片审核](https://cloud.tencent.com/document/product/460/63594)、[文本异步审核](https://cloud.tencent.com/document/product/460/88135)、[图片查询](https://cloud.tencent.com/document/product/460/68905)和 [文本查询](https://cloud.tencent.com/document/api/460/56284)。
