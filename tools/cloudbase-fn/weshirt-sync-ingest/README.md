# CloudBase 抓取回写适配器

[English](README.en.md)

用于 Edge 侧访问设备上游不稳定、需要 CloudBase 出口抓取的部署。函数调用项目共用的 `packages/core/haier.js`，取得完整快照后 POST 到 `/api/cron/ingest`；归一化规则、看板、故障复核和通知仍由服务端处理。不要用仅唤醒 Edge 的 ping 函数替换这条链路。

## 打包与部署

在仓库根目录安装锁定依赖，然后运行：

```bash
node tools/cloudbase-fn/build-ingest.mjs
```

将 `.cloudbase-build/weshirt-sync-ingest/` 中的 `index.js` 与 `package.json` 上传到 CloudBase。构建使用项目要求的 Node 环境，生成包面向 Node.js 18 及以上，入口为 `index.main`，无需再安装依赖。不要直接上传源目录的 `index.mjs`，它引用仓库共用模块。构建目录应加入 `.gitignore`。

## 环境变量

| 新名称 | 兼容旧名称 | 说明 |
| --- | --- | --- |
| `WESHIRT_INGEST_URL` | `INGEST_URL` | HTTPS 站点的 `/api/cron/ingest` |
| `WESHIRT_SYNC_URL` | `SYNC_URL` | 可选，同一站点的 `/api/cron/sync`，用于失败回退 |
| `WESHIRT_SYNC_KEY` | `SYNC_KEY` | 专用同步密钥，只通过 JSON 请求体传递 |

新名称有值时优先。两个 Edge 地址必须同源，路径必须完全匹配，不允许查询参数、片段或 URL 内凭据。配置 `HAIER_URL`、`HAIER_POSITION_ID`、`HAIER_HEADERS`、`HAIER_PAYLOAD` 等现有上游参数，含义与主项目一致；函数强制使用真实模式。上游地址必须是 HTTPS，不能与 Edge 回写地址同源，上游鉴权头只发送给上游。

## 执行与排查

平台总超时可设为 40 秒；适配器内部总预算为 30 秒，涵盖响应体读取、回写和回退。抓取最多使用 25 秒，给回写预留时间。任一楼层、类别或分页失败，或快照为空、超出 500 台、原始状态无效，均不提交部分设备。`rawState` 转回整数 `state`，结束时间以 ISO 写入 `finishTime`，服务端不会重复加北京时间偏移。

抓取或回写失败时，仅在剩余预算内调用一次可选同步回退；预算耗尽则等待下一次调度。上游仍使用共用客户端的有限重试。单个上游响应最多 1 MiB，Edge 响应最多 64 KiB，累计响应最多 4 MiB；不跟随重定向。回写除 HTTP 成功外还校验业务结果，`ok:false` 不能算成功。

结果含 `mode`、`snapshotComplete`、`status`、`eventId`；回退结果保留固定分类的 `initialFailure`，不会掩盖原快照失败。日志仅记录固定原因、状态与事件标识，不打印请求头、密钥、原始异常或响应正文。按平台支持配置至少每分钟调度一次，限制并发与平台自动重试；同一站点选择适合的触发方式，避免同时部署重复定时器。
