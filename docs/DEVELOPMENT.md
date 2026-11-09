# 开发与发布

[返回首页](../README.md) · [English](DEVELOPMENT.en.md)

## 本地开发

使用 Node.js 22.18+（22 LTS）或 24.11+、npm 和锁文件安装依赖。复制 `.env.example` 后先填 `AUTH_SECRET`（至少 16 字符）与 `ADMIN_TOKEN`（至少 8 字符），再启动。缺少凭据时公开模拟看板仍可读，登录与后台拒绝请求。

```bash
npm ci
npm run dev
```

前端 `http://localhost:5173`，API `http://localhost:8787`，管理页 `/#/admin`。默认使用模拟机器，真实登录、数据源及消息通道需按 [配置](CONFIGURATION.md) 设置。`VITE_API_BASE` 由前端统一使用，同域生产留空。

## 检查

```bash
npm test
npm run build
```

测试使用模拟接口和本地存储，不应向真实通知或上游发送请求。涉及登录、成员权限、异步切换、队列、提醒去重和持久化的改动需要对应回归。前端验证包含移动端与列表回退，UI 草稿在失败或刷新时应保留。

角色与巡检的针对性检查：

```bash
node --test tests/identity-roles.test.js tests/inspections.test.js tests/inspection-integration.test.js
```

集成回归必须使用真实 `createApp` 与签名用户令牌，覆盖管理员只能管理志愿者、账号总管可修改最高配置、封停及撤权即时生效、机器实际楼栋范围、私有照片访问与类型/大小限制、指定楼群投递失败和持久冷却。钉钉请求使用本地桩，不能通过真实群消息验证测试。检查记录淘汰及每次有限照片清理，不得把人工巡检异常直接当成设备故障。

公共频道与楼栋频道均公开可读，楼栋筛选不构成私密访问控制；内容治理只授予总管和管理员。登记备注及消毒液、自清洁标记属于当前占用的公开 `care` 记录，须以纯文本展示，取衣后清除公开投影；本人任务历史与巡检照片分别使用各自权限，不能混用公开字段。

Edge 兼容性构建命令见 [部署](DEPLOYMENT.md)。Node 与 Edge 共用 `packages/core/` 中的标准 Web API 模块，Node 专用文件与 Edge 入口隔离。

## 分支与生产发布

`dev` 为开发集成分支，`master` 为生产发布分支。

1. 功能分支向 `dev` 提交 PR，通过测试与构建后合并。
2. 在预览环境验证登录、楼栋、任务公开记录、预约、公告、频道治理、角色范围、巡检照片和通知。
3. 由本仓库的 `dev` 向 `master` 发起生产 PR；其他分支和 fork 的同名分支不能晋升。
4. 检查通过并人工审核后合并，生产从 `master` 构建部署。仓库工作流不自动推送主干或部署生产。
5. 发布后核对健康、存储、同步和通道结果，保留上个构建与数据备份。

GitHub Actions 使用最新 Node 22 LTS（至少 22.18）安装、测试、前端构建和 Edge 兼容检查，并提供 JavaScript/TypeScript CodeQL 工作流。Dependabot 每周检查 npm 与 Actions，更新 PR 目标为 `dev`。

在 GitHub 分支保护或 Ruleset 中将 `Tests and build` 与 `Promotion policy` 等检查设为 `master` 必需项并禁止直接推送。晋升检查仅通过 `pull_request_target` 读取可信 PR 元数据，不检出 PR 源码、不读取密钥。CodeQL 高级工作流应避免与默认设置重复启用。

## 发布源码范围

提交源代码、测试、锁文件、构建与 CI 配置、脱敏模板及公开文档。不要提交 `.env`、数据目录、部署缓存、凭据、日志、截图中的个人信息、私有交接记录或本地 Git 历史快照。依赖、构建输出和生成的 Edge 检查产物不进入源码仓库。

固定测试数据使用虚构楼栋、保留示例域名及合成凭据，不复用生产点位、设备或账号 ID。接口文档与代码实际行为一起维护，CI 不需要部署密钥。

## 目录

| 路径 | 内容 |
| --- | --- |
| `frontend/`、`public/` | Vue 3、Pinia、Vant、Three.js、图标与 Service Worker |
| `packages/core/` | 共用业务逻辑、状态与通道实现 |
| `server/`、`functions/` | Hono、Node 入口与 Edge API |
| `tests/` | `node:test` 回归 |
| `tools/` | 图标、VAPID 与受保护同步触发器 |
| `.github/` | CI、代码扫描、依赖更新与晋升策略 |

晋升合并后，将 `master` 合并回 `dev` 再继续开发，以满足下一次严格的分支更新检查；不要强推或绕过生产保护。

## 请求可靠性约定

新增写接口必须维护权限校验、范围验证、幂等规则和审计。`server/request-safety.js` 负责错误事件与可选幂等回复，`server/audit-middleware.js` 记录业务请求，`server/permissions.js` 执行个人授权。审计先于请求安全与权限注册，读取最终状态和同一事件 ID。业务正文、照片和凭据不得进入日志。

回归应覆盖并发提交、不同正文复用标识、账号/角色/个人规则变更、昵称旧响应覆盖和范围过滤。当前互斥覆盖同运行时及同 store 对象，Edge KV 的最终一致性不能提供跨节点事务；高并发部署需要单写协调或事务存储，不能用浏览器按钮禁用来代替服务端并发处理。
