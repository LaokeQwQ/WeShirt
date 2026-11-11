# 原生移动端后端接入

Android 包名为 `com.laoke.weshirt`。移动登录、推送和 WebSocket 分别发现能力，不因客户端安装成功就视为已经接通。所有开关默认关闭；未配置时返回明确的未配置状态，保留现有网页功能。

## 原子会话存储

移动会话需要跨节点的持久原子读写。现有 EdgeOne KV 和进程内锁不满足刷新令牌轮换、防重放的要求，不能代替下列 CloudBase 数据库事务适配器。

1. 默认使用 CloudBase PostgreSQL。先审查并通过迁移流程应用 `cloudbase/migrations/20261111030000_mobile_atomic_store.sql`，建立私有表、服务端 RPC、ACL 与强制 RLS；确认云函数 SDK 服务凭据映射为 `service_role`。客户端不得直接访问会话表，详见 [PostgreSQL 原子存储](mobile-postgres-store.md)。不要在 PostgreSQL 环境调用文档数据库的集合或安全规则 API。
2. 在后端仓库运行 `npm ci` 和 `node tools/cloudbase-fn/build-mobile-store.mjs`。生成目录为 `.cloudbase-build/weshirt-mobile-store`。
3. 在生成目录执行 `npm install --omit=dev`，将该目录上传为 Node.js 22 的 CloudBase Event 云函数，入口为 `index.main`。为它创建 HTTPS 访问路由，上游类型为 `SCF`。
4. 云函数配置以下变量。桥接凭据须在本地安全生成后分别填入两端环境配置，不写进源码、App、工单或日志。

| 云函数变量 | 要求 |
| --- | --- |
| `CLOUDBASE_ENV_ID` | 目标 CloudBase 环境；同环境部署可使用 SDK 当前环境 |
| `MOBILE_ATOMIC_STORE_SECRET` | 至少 32 个随机字符，建议 32 字节安全随机数的 Base64URL 编码 |

5. EdgeOne 服务端配置 `MOBILE_ATOMIC_STORE_URL`（完整 HTTPS 路由，不带查询参数）和相同的 `MOBILE_ATOMIC_STORE_SECRET`。禁止网关记录 Authorization 或请求体；此地址与凭据仅在服务端使用。

桥接只接受 POST、服务端 Bearer 凭据和限定的 `mobile:*` 命名空间，拒绝访问账号、消息及其他业务 KV。连接或事务失败时返回失败，不回退到最终一致存储，也不自动重试不确定写入。

Node 部署也可直接注入 PostgreSQL 适配器，无需 HTTP 桥接：

```js
createApp({ store, env, mobile: { atomicStore: createCloudBasePostgresAtomicStore(app.rdb()) } })
```

仅在另有文档数据库环境时，可选用保留的 `createCloudBaseMobileAtomicStore(db)` 与该环境的 `runTransaction`。这是独立部署选择，不使用上面的 PostgreSQL 迁移，也不能把文档数据库的集合配置混入默认云函数。

## 钉钉登录

服务端最小变量为：

| 变量 | 要求 |
| --- | --- |
| `MOBILE_AUTH_ENABLED` | 完成配置后显式设为 `true` |
| `DINGTALK_MOBILE_CLIENT_ID` | 正式原生应用 Client ID |
| `DINGTALK_MOBILE_CLIENT_SECRET` | 该原生应用私有 Secret，只放服务端 |
| `DINGTALK_MOBILE_REDIRECT_URI` | 钉钉登记的 HTTPS 回调 URI |

同时在钉钉平台登记 `com.laoke.weshirt` 和实际自签发行证书指纹。使用新 `ddopenauth` SDK、`scope=openid` 和统一 OAuth 用户令牌接口，不使用旧 SNS 临时码，不回退复用网页登录凭据。

`GET /api/mobile/config` 公布能力；`POST /api/mobile/auth/challenge`、`exchange`、`refresh`、`logout` 负责挑战与会话。挑战有效 180 秒，访问令牌有效 15 分钟，刷新会话绝对有效期 30 天。并发刷新只有一个成功；响应丢失后重新授权，不能继续重试旧令牌。客户端须原子保存整组新凭据。

首版只关联已有可信钉钉账号，按已验证的 `unionId` 或企业通讯录映射核实身份，禁止按昵称或手机号合并。网站账号目录仍在 KV，原生单独建立新身份会导致网页和原生首次并发注册时分裂账号；需先让用户通过网站登记，或将两种注册入口一起迁移到统一身份事务。未关联时返回 `409 account_link_required`。

## 推送

原子存储可用后，显式设置 `MOBILE_PUSH_ENABLED=true`，并配置至少一个真实发送器：

| 通道 | 服务端变量 |
| --- | --- |
| FCM HTTP v1 | `FCM_SERVICE_ACCOUNT_JSON`，目标 Firebase 项目的服务账号 JSON，含项目、服务账号邮箱和 PKCS#8 私钥 |
| 友盟 U-Push | `UMENG_PUSH_APP_KEY`、`UMENG_PUSH_MASTER_SECRET`，与 Android 对应应用一致 |

FCM 使用服务账号 RS256 JWT 获取 `firebase.messaging` 范围的 OAuth 凭据；友盟对实际请求字节计算官方要求的 MD5 签名。发送地址固定为厂商官方 HTTPS 地址，禁止重定向。

友盟可选 `UMENG_PUSH_PRODUCTION=false` 用于调试，默认生产。仅发送 `display_type=message`、`body.custom` 标准数据消息，由 Android 客户端校验、去重并显示通知。只集成 FCM 与基础 U-Push，不接入独立手机厂商 SDK、厂商通知转换或渠道参数；同一安装只登记一个通道。

`GET/PUT /api/mobile/installations/:installationId` 管理安装登记。启用正文为 `{provider:"fcm"或"upush",token,notificationsEnabled:true,appVersion}`；关闭正文为 `{notificationsEnabled:false,appVersion}`。返回信息不包含令牌。原生会话只能操作自身安装，每台设备只保留一个主通道，每用户最多五台设备。旧会话退出不能清除更新会话的设备登记。

社区 @、取衣、排队和代取通知使用独立原子待发队列，钉钉成功不会取消原生通道自己的重试。失败最多四次，递增退避，消息最长保存一天。同步每次最多并行发送八条，轮转用户索引；过期、失败耗尽和已发送条目可回收。权限撤销、账号停用、关闭通知、取衣或取消排队会抑制后续投递。

载荷为 `{eventId,revision,kind,title,body,taskId,finishAt,serverConfirmed}`。客户端按事件及递增版本去重，更新版本会抑制旧版本重试。FCM 明确返回 `UNREGISTERED` 才自动注销令牌；参数、凭据或网络错误不会被误判成卸载。网络结果不确定时仍可能重复收到数据。

`taskId` 对本人任务为原编号，对排队为 `queue:<reservationId>`，`finishAt` 为 ISO 预计结束时间，无时间或稳定编号时对应字段为空字符串。客户端可据此合并同一任务周期的本地提前/预计结束提醒；只有 `serverConfirmed=true` 的 `TASK_FINISHED` 才表示服务端确认结束。

## 验收范围

仓库测试使用临时生成的 RSA 测试密钥、模拟厂商响应和测试原子存储。没有应用凭据、数据库部署和发行证书登记时，能力发现保持未配置；登记接口通过也不代表真机投递通过。

上线前需在独立测试环境验证两节点并发兑换、刷新竞争、退出、新旧会话设备登记，以及 FCM 与基础 U-Push 测试设备的前后台接收、通知点击、关闭提醒、卸载重装。日志只记录事件编号、状态码和安全分类，不记录消息正文、手机号、授权码、用户令牌或发送端私钥。

原生首版使用至少 30 秒间隔的前台 HTTP 刷新，小组件建议五分钟，倒计时每秒只在本地更新。原生 WebSocket 的限定频道一次性票据尚未开放，不伪造浏览器 Origin 绕过校验。

参考：[CloudBase 事务](https://docs.cloudbase.net/database/transaction)、[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[服务账号 OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)、[友盟消息格式](https://devs.umeng.com/docs/67966/detail/68343)。
