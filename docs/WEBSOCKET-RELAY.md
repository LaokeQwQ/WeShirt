# 频道 WebSocket 中继

中继为浏览器提供真实 WebSocket 长连接。它每 4 秒从固定的应用后端读取频道版本号与自己的未读数量，只有变化时推送失效事件；浏览器收到事件后仍通过原 HTTP API 获取消息。**内部仍有轻量轮询，不是数据库端到端事件推送。** 无连接时不读取后端，页面隐藏时客户端应关闭连接。

## 已核实的部署条件

当前环境有对象存储和 PostgreSQL 后端，没有可用的传统 NoSQL 数据库，也未开通云托管。传统 `collection.watch()` 只适用于文档型数据库，不能将存储能力当作 Mongo 能力。改用 PG 实时订阅需要单独整合数据库权限与身份，目前不作为部署前置条件。

CloudBase Web 云函数支持 `type: HTTP`、`protocolType: WS`，服务监听 9000。平台每条连接对应独立实例，因此进程内 `Map` 无法广播到其他实例。本中继从固定后端读取共享版本号，可以跨实例工作，无需新建数据库、Redis 或容器。长连接占用函数运行时间和并发额度；应监控实际用量。

## 协议与边界

1. 浏览器用真实用户 Bearer 请求 `GET /api/messages/realtime?channel=...`。后端返回 `{enabled,url,protocol,ticket,expiresAt}`。未配置时保持 HTTP 轮询。
2. 浏览器执行 `new WebSocket(url, 'weshirt.channel.v1')`，连接 URL 不携带票据；打开后发送 `{type:'authenticate',ticket}`。
3. 中继只请求配置中的固定 HTTPS 后端 `/api/messages/realtime/state`，票据放 Authorization 头，同时生成每连接独立的 `X-Community-WS-Connection: <24hex>`。后端校验独立 `COMMUNITY_WS_GATEWAY_SECRET`、120 秒有效期、账号启用、频道权限和最多 2 条连接租约；不能仅以可复用的 ticket nonce 计数。中继的票据解析只作格式预筛，不能替代签名校验。断开时向固定 `/api/messages/realtime/release` 发同样两个头的无 body POST，最多等待 1 秒，失败由短租约到期回收。客户端不能指定连接 ID。
4. 首次通过后中继发送 `{type:'ready',channel,expiresAt,revision,inboxCount}`；客户端应补拉消息。之后 revision 或 inboxCount 变化才发送 `{type:'channel.changed',channel,revision,inboxCount}`。中继不接触或转发消息正文、用户身份、媒体或通知收件人。
5. 客户端每 25 秒发送 `{type:'ping'}`，收到 `{type:'pong'}`；其他客户端指令均拒绝。客户端不能发布消息。到期、撤权、后台失效或连续失败会断开，客户端需重新取票、退避重连，重连后补拉。

安全约束包括精确 Origin 白名单、禁止查询参数票据、首帧 5 秒认证期限、4096 字节帧/响应上限、3.5 秒后端超时、禁跳转、固定出站地址、慢连接关闭和最多 3 次连续失败。中继不保存 AUTH_SECRET、WS 签名密钥或 CloudBase/CAM 凭证，不输出原始异常、地址、请求体或票据。部署者只允许受信任管理员修改出站 origin。

## 安装和部署

代码目录：`tools/cloudbase-fn/weshirt-channel-gateway/`。根项目开发依赖包含 `ws`，CI 按根 lockfile 安装后构建，无需测试时联网安装：

```sh
npm ci
node tools/cloudbase-fn/build-channel-gateway.mjs
```

构建把 `ws` 的纯 JS 实现打包到 `.cloudbase-build/weshirt-channel-gateway/index.cjs`，产物不依赖部署时 npm install 或上传 node_modules；可选本地加速模块不必安装。另有无依赖 `package.json` 和 LF 换行的可执行 `scf_bootstrap`。启动文件使用官方 Nodejs20.19 的 `/var/lang/node20/bin/node`，监听 `0.0.0.0:9000`。本地无需修改全局 Node 安装。独立源码 package/lockfile 仅用于隔离开发，不上传其中的 node_modules。

新建独立函数 `weshirt-channel-gateway`，不更新已有同步函数。配置如下：

```json
{
  "name": "weshirt-channel-gateway",
  "type": "HTTP",
  "runtime": "Nodejs20.19",
  "protocolType": "WS",
  "protocolParams": { "wsParams": { "idleTimeOut": 35 } },
  "timeout": 150,
  "instanceConcurrencyConfig": { "dynamicEnabled": false, "maxConcurrency": 1 }
}
```

只注入这两个非密钥配置：

- `EDGE_API_ORIGIN`：实际应用 API 的 HTTPS origin，无路径、凭据、查询参数。
- `COMMUNITY_WS_ALLOWED_ORIGINS`：实际前端 HTTPS origin，多个以逗号分隔；不使用通配符。

先运行 `node tools/cloudbase-fn/prepare-channel-gateway.mjs <实际 API HTTPS origin> <实际前端 HTTPS origins> <本地私有输出目录>`，它只生成可审阅的 `create-function.json` 与 `create-route.json`，不会调用云服务。不要把生成的部署站点配置提交到公开仓库。

通过现有 CloudBase MCP `manageFunctions(createFunction)` 部署，使用生成的 `create-function.json`，保留指向 `.cloudbase-build` 的绝对 `functionRootPath`，不传 `zipFile`。当前 MCP 的创建分支不会向 Manager SDK 传递 `zipFile`：只传 ZIP 会出现路径错误；同时传目录和 ZIP 仍会重新打包目录，并非优先上传自制 ZIP。该工具链已在 Windows 目录部署中验证可运行，下载产物的启动文件带可执行权限；不同工具版本仍须重新验证。

如需本地留档，可运行 `python tools/cloudbase-fn/package-channel-gateway.py <create-function.json> <本地私有输出目录>`。它校验 3 个产物及 LF/无 BOM，并生成 bootstrap 为 Unix 0755 的审计 ZIP，以及保留目录、移除 `zipFile` 的 `create-function-with-root.json`。**此 ZIP 只是留档，不是该创建请求实际上传的包。** 旧版 helper 生成的 `create-function-packaged.json` 不适用于当前 MCP 创建流程，不要继续使用。

如果必须逐字节部署预制 ZIP，使用 MCP 的两段式路径：`queryFunctions(action=getFunctionUploadUrl)` 获取当前环境的预签名上传信息，原样 PUT ZIP 后，将返回的 `cosBucketName`、`cosObjectName`、`cosBucketRegion` 放入 `manageFunctions(createFunction)` 的 `code` 字段，不传本地目录或 `zipFile`。不要自行猜测桶或对象路径，也不要把预签名地址写入公开日志。已有函数则使用相应 `updateFunctionCode` 操作，不能假定它与创建分支的 ZIP 参数行为相同。

然后创建公开 HTTP 网关映射 `upstreamResourceType: WEB_SCF`，前缀 `/weshirt-channel-gateway`、`enablePathTransmission: false`（匿名仅能到握手，应用票据仍必验）。生成请求带网关 IP/QPS 限制，可按真实校园 NAT 流量调整。使用返回的真实 `wss:` 地址配置应用的 `COMMUNITY_WS_GATEWAY_URL`，不要猜测函数域名。`COMMUNITY_WS_GATEWAY_SECRET` 只在应用后端配置，与 AUTH_SECRET 分离。开启平台 WS 协议后不可取消，回退时移除应用的 gateway URL 即恢复原轮询，独立函数可保留或单独删除。

## 验收

运行 `node --test tests/channel-gateway.test.js`。测试包含本地真实 WS 握手，不访问外部应用。部署后下载实际函数代码包，核对仅含这 3 个文件、bundle 与本地构建一致、bootstrap 无 BOM/CRLF 且具有 Unix 可执行位；本地审计 ZIP 的权限不能证明云端实际使用的权限。再检查 `GET /health`，并由合成测试账号取票完成首次 ready、消息版本改变、频道切换、页面隐藏恢复、账号禁用/撤权、过期重连。无票据、跨 Origin、query 票据、跨频道和客户端 publish 均应拒绝。应用 ACL 测试独立覆盖 state 端点。

## 官方依据

- [WebSocket 协议、单连接实例、端口与配额](https://docs.cloudbase.net/cloud-function/develop/websocket)
- [HTTP/WS 云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)
- [部署 HTTP 云函数](https://docs.cloudbase.net/cli-v1/functions/deploy)
- [传统文档型数据库实时推送](https://docs.cloudbase.net/database/realtime)
- [PG 实时推送与传统 watch 的区别](https://docs.cloudbase.net/en/api-reference/webv3-pg/realtime/quick-start)
