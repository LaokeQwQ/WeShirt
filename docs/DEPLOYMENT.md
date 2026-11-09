# 部署说明

[返回首页](../README.md) · [English](DEPLOYMENT.en.md) · [配置](CONFIGURATION.md)

## 推荐：腾讯 EdgeOne Pages + 腾讯 CloudBase

这是全云端 SaaS 部署形态，免自建服务器，降低单机故障风险。各组件承担的职责如下：

| 组件 | 职责 |
| --- | --- |
| EdgeOne Pages | 托管 `dist/` 前端与静态资源 |
| Edge Functions | 运行 `functions/api/[[default]].js`，承载 Hono API、同步和通知判定 |
| 绑定的持久化 KV | 保存用户、任务、站点配置、队列、快照与运营状态 |
| CloudBase 定时函数 | 只 POST 到受保护同步端点，保证无人访问时仍有检查机会 |

此方案没有使用 CloudBase 数据库。CloudBase 触发器不抓上游、不发送原始设备列表、不直接生成通知。平台或上游故障仍可能影响可用性，托管不意味着没有中断风险。

### 1. 构建与 API

将仓库导入 EdgeOne Pages，**生产分支选择 `master`**，`dev` 仅用于预览；不要将开发分支自动发布到生产。设置构建命令 `npm ci && npm run build`，输出目录 `dist`。保留 `functions/api/[[default]].js` 为 `/api/*` 的唯一函数入口。构建使用 Node.js 22.18+（22 LTS）或 24.11+；旧版 22.11 无法满足当前依赖。

已有 Upload 类型项目可继续使用 CLI 上传，但必须先检出已晋升的 `master`，从独立目录构建，并记录发布 commit。不要在公开源码工作区拉取或写入生产 `.env`，也不要把只含静态页面的 `dist` 当成完整 API 部署。

通过部署平台支持的函数环境配置注入服务端变量，至少填写 `AUTH_SECRET` 与 `ADMIN_TOKEN`，长度要求见 [配置](CONFIGURATION.md)。生产同域访问时 `VITE_API_BASE` 留空。使用自定义 HTTPS 域名，并同步配置钉钉回调。

创建持久化 KV 并绑定到项目，推荐变量名 `LAUNDRY_KV`。入口兼容 `context.env` 与平台全局绑定。登录后台运行存储自检，确认连续请求可读取刚保存的数据；无 KV 的内存回退仅用于调试。

### 2. CloudBase 同步触发器

上传 [触发器目录](../tools/cloudbase-fn/weshirt-sync-ping/README.md) 的 `index.js` 与 `package.json`，使用 Node CommonJS 入口 `index.main`，无需第三方依赖。平台函数超时设为大于 30 秒。

| 环境变量 | 配置 |
| --- | --- |
| `WESHIRT_SYNC_URL` | `https://laundry.example.test/api/cron/sync`，替换为自己的站点 |
| `WESHIRT_SYNC_KEY` | 后台提供的专用同步密钥 |

密钥放在环境变量中，以 POST JSON `{ "k": "..." }` 发送。URL 不含 query、账号密码或密钥。不要使用管理员口令代替同步密钥。更换 `AUTH_SECRET` 后更新触发器密钥。

按平台能力配置至少每分钟检查一次。提前 3 分钟提醒需要检查进入时间窗口，每 5 分钟调度可能错过。触发器设 30 秒总超时，单次不重试、不跟随重定向，不打印配置或响应正文；平台自身重试也应控制并发。

### 3. 上线验证

检查 `/api/health`、公开看板和后台存储状态；观察无人打开页面时同步时间是否前移。再验证登录、住宿楼保存、公告和通知诊断。真实通知测试只发送给预期接收人，避免用群消息反复试错。

后台保存配置后确认刷新仍可读取。检查定时器失败原因、同步失败次数及通道投递结果；触发器 HTTP 成功代表请求完成，业务健康以后台同步诊断为准。保留前一个生产构建和数据备份。

## 缓存与资源

保留 `edgeone.json` 的缓存区分：带哈希的 `/assets/*` 长期缓存，`/`、`/index.html`、`/sw.js` 使用 `no-cache`，`/api/*` 不进入静态缓存。Service Worker 仅复用同源哈希资源和图标，最多 60 个，不提供完整离线业务能力。

前端按路由懒加载 Three.js。3D 机位需要现场核对，未绑定设备显示明确空态；其他楼栋可使用列表。

## 可选：Node 私有部署

```bash
npm ci
npm run build
npm start
```

先配置 `.env` 中的必要密钥。`npm start` 仅提供 API，不托管 `dist/`；用 Nginx 或 Caddy 托管静态目录，将 `/api/*` 代理到 Node 监听端口，并启用 HTTPS。前端使用 hash 路由。

Node 启动先同步一次，之后按 `server/index.js` 的周期检查。使用进程管理器保持运行，`DATA_DIR` 挂载持久化存储并备份。多进程不能共写同一个 FileStore；多实例需先适配合适的共享存储。同步检查间隔应小于提醒窗口。

## Edge 兼容检查

```bash
npx --no-install esbuild 'functions/api/[[default]].js' --bundle --format=esm --platform=browser --target=es2022 --outfile=./edge-check.mjs
```

检查后删除产物。Node 专用模块保留在独立入口，不能进入 Edge 业务核心。平台配置细节可能变化，以当前平台控制台及官方说明为准。网络诊断见 [同步与网络](EGRESS.md)。
