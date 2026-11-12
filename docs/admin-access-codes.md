# 临时管理员口令

总管可以创建和销毁临时口令，设置名称、备注、有效时长，以及功能查看/操作和楼栋范围。默认有效 12 小时，最长 30 天；默认能力等同管理员，不能获得总管专属的密钥、最高成员授权、个人权限或系统恢复能力。

完整口令只在创建成功的响应中返回，关闭创建结果后前端清空明文。列表仅返回前后缀；遗失时销毁重建。服务端保存 SHA-256 摘要，不保存完整口令。创建请求不进入通用幂等响应缓存；同一请求标识再次提交返回 409，不重复创建或重放明文。

口令用于现有 `POST /api/admin/login`，换取有期限的后台会话。每次临时会话请求都从线性一致的原子存储重新读取口令状态，无 Edge KV 授权缓存。销毁后所有派生会话立即停止通过下一次鉴权；存储不可用时拒绝访问。已进入执行的单个业务操作不能回滚，用户批量操作会在每个目标执行前再次检查会话。原有环境变量 `ADMIN_TOKEN` 和原后台会话保留兼容。

## 部署

复用移动会话的原子存储与服务端私有桥接配置。新增键白名单 `mobile:admin-access-codes:registry`；CloudBase 文档事务、PostgreSQL RPC、远程桥均使用同一校验函数，无新增数据库表或迁移。

先在仓库执行 `node tools/cloudbase-fn/build-mobile-store.mjs`，构建 `.cloudbase-build/weshirt-mobile-store`，沿用现有 `weshirt-mobile-store` 云函数、Node.js 22 和 `index.main` 入口更新部署，再部署 API。保留原函数的私有环境变量，不复制到客户端或公开仓库。旧桥未更新或原子存储未配置时，此功能返回 503，原静态管理入口继续可用。

## 接口

| 路由 | 行为 |
| --- | --- |
| `GET /api/admin/access-codes` | 总管查看脱敏列表、权限资源、管理员能力上限和楼栋 |
| `POST /api/admin/access-codes` | 总管创建，要求 `Idempotency-Key`；正文为 `name`、可选 `note`、`ttlHours`、`permissions` |
| `DELETE /api/admin/access-codes/:id` | 总管销毁，重复销毁保持成功 |
| `POST /api/admin/login` | 正文 `token` 兼容临时口令，返回 `session`、`expAt`、`ttlMs`、`kind:temporary` 和权限 |
| `GET /api/admin/session` | 返回当前临时会话身份、有效期和实时权限 |

授权范围格式复用个人权限的资源行。创建时省略 `permissions` 使用完整管理员能力；指定资源只能收窄，不能开启管理员原本不具备的能力。临时会话与用户 Bearer 同时存在时，以临时权限作为约束，不借用 Bearer 总管身份升级。所有写入、拒绝和重试通过现有操作审计记录，错误保留状态码和事件编号，审计不记录口令或权限正文。
