# 移动会话的 PostgreSQL 原子存储

PostgreSQL 环境使用 `@cloudbase/node-sdk` 3.18.7 的 `app.rdb().rpc()`。云函数仍是 `weshirt-mobile-store`，入口为 `index.main`，运行时使用 Node.js 22。EdgeOne 继续通过带服务端 Bearer 凭据的 HTTPS 桥接访问，移动端不持有数据库凭据。

## 数据与事务

迁移文件为 `cloudbase/migrations/20261111030000_mobile_atomic_store.sql`。它创建专用 schema `weshirt_mobile_private`、表 `weshirt_mobile_sessions` 和两个公开 RPC：

| RPC | 行为 |
| --- | --- |
| `weshirt_mobile_atomic_get` | 返回未过期的版本和值；不存在或过期时返回 `null` |
| `weshirt_mobile_atomic_cas` | 仅在当前有效版本匹配时写入；`expectedVersion=null` 只能创建缺失或已过期记录 |

键在进入数据库前转换为 SHA-256 Base64URL 摘要。每个 RPC 在自己的数据库事务内取得对应键的 advisory transaction lock，再读取数据库时间和有效版本。锁覆盖尚不存在的记录，因此首次并发写入也只有一个成功。版本由服务端生成新的 UUID；成功更新必须更换版本。

过期时间在数据库中再次验证，必须晚于当前数据库时间且不超过 100 天。过期记录立即视为不存在，不依赖后台清理。`expires_at` 索引用于管理员安排清理；本迁移不创建定时任务。

RPC 始终返回 `{protocolVersion:1,ok:true,result:...}` 对象。这样可以保留 SDK HTTP 适配中容易丢失的标量 `false` 和 `null`。网络或数据库错误直接失败，不重试结果不确定的 CAS。

## 权限边界

表位于独立私有 schema；`PUBLIC`、`anon`、`authenticated` 没有 schema 或表权限。表启用并强制 RLS，只有 `service_role` 有读写策略。

两个 RPC 使用 `SECURITY INVOKER`，固定空 `search_path`，并在函数体内校验已签发 JWT 的 `request.jwt.claims.role` 必须为 `service_role`。CloudBase 当前不强制校验 RPC 的 `GRANT EXECUTE`，所以仅撤销函数执行权限不足以保护会话数据。即使端点被客户端触达，身份校验、私有表 ACL 和 RLS 仍分别生效。

发布前必须确认目标环境中云函数 SDK 的服务端凭据实际映射到 `service_role`。SDK 提供 `rdb()` 不代表该凭据已经通过 PostgreSQL 身份验证。未满足时接口保持失败，不放宽为用户角色，也不把数据库服务凭据交给客户端。

## 发布与验收

1. 检查目标环境的服务身份、现有对象与迁移计划。迁移使用 `CREATE`，遇到同名对象会停止，不替换现有对象。通过 CloudBase PostgreSQL 迁移流程应用 SQL；不要将原文档数据库的集合创建或安全规则 API 用于该表。
2. 运行 `node tools/cloudbase-fn/build-mobile-store.mjs`，在生成目录 `.cloudbase-build/weshirt-mobile-store` 执行 `npm install --omit=dev`。函数只需要 `MOBILE_ATOMIC_STORE_SECRET` 与 `CLOUDBASE_ENV_ID`；表与 RPC 名称固定，不接收集合名称变量，不复制网站的其他私有变量。
3. 创建仅指向这个新 Event 函数的 HTTPS 路由，配置 `MOBILE_ATOMIC_STORE_URL` 与 `MOBILE_ATOMIC_STORE_SECRET`。两个移动端开关在验收完成前保持关闭。
4. 验证无凭据 POST 返回 401、带凭据 GET 返回 405，并确认数据库策略拒绝客户端直接访问。
5. 使用独立随机 `mobile:limit:deployment-check:<random>` 键、60 秒过期时间，通过不同 HTTP 请求并发争抢同一版本。缺失键创建和现有版本更新都必须只有一个成功；失败旧版本不得覆盖值。
6. 验收后核对本次测试标记与摘要键，只删除该测试记录。不要使用会话前缀批量清理。

本地测试通过 PGlite 执行真实 PostgreSQL SQL，覆盖迁移、过期、版本竞争、角色检查、ACL 与 RLS。PGlite 使用单连接；它验证 SQL 行为，云端多进程锁竞争仍需第 5 步的真实 HTTP 验收。

参考：[CloudBase RPC 与权限边界](https://docs.cloudbase.net/database/postgresql/rpc)、[PostgreSQL 身份映射](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)、[CloudBase 数据库连接](https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql)、[PostgreSQL advisory lock](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)。
