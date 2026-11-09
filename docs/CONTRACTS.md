# WeShirt · 接口契约（并行开发的唯一事实源）

> 所有子任务必须严格遵守本文件。任何接口变更必须先改这里。

## 0. 目录与文件归属

| 目录/文件 | 负责人 | 说明 |
|-----------|--------|------|
| `packages/core/store.js` `auth.js` `util.js` | **Agent Backend** | 存储抽象、身份、工具 |
| `packages/core/haier.js` `machines.js` `tests/haier.test.js` | **Agent Scraper** | 海乐抓取 + 状态机 |
| `packages/core/dingtalk.js` `tests/dingtalk.test.js` | **Agent DingTalk** | 钉钉加解密/指令/消息 |
| `packages/core/webpush.js` `tests/webpush.test.js` | **Agent Push** | Web Push 加密发送 |
| `server/app.js` `server/index.js` `functions/**` | **Agent Backend** | 路由与双形态适配 |
| `frontend/**` `public/**` | **Agent Frontend** | H5 界面 |
| `docs/**` `package.json` `vite.config.js` `README.md` | 主控 | 不属任何 agent |

**禁止**：agent 不得修改不属于自己的文件；不得执行 git 命令。

## 1. 环境变量

```
PORT=8787                # 服务器形态端口
DATA_DIR=./data          # FileStore 落盘目录
AUTH_SECRET=<32+ 位随机>  # HMAC token 密钥；**必填**，短于 16 位视为未配置（登录直接 503）
ADMIN_TOKEN=<12+ 位随机>  # 管理口令；**必填**，短于 8 位视为未配置（管理接口全拒）
HAIER_MODE=mock          # mock | real
HAIER_URL=               # real 模式：接口根地址（如 https://yshz-user.haier-ioc.com）
HAIER_HEADERS={}         # real 模式：JSON 字符串，至少含 Authorization
HAIER_ACCOUNTS=          # real 模式（可选）：账号池，多个账号轮询，被限流自动切换
                         #   ["Bearer a","Bearer b"] 或 [{"Authorization":"Bearer a"}, ...]
                         #   配了就忽略 HAIER_HEADERS；单账号时行为不变
HAIER_PAYLOAD={}         # real 模式：旧版单接口模式的下发体（无 POSITION_ID 时使用）
HAIER_POSITION_ID=       # real 模式：洗衣房点位 id（nearPosition 返回的 id）。设置后走多点位流程
HAIER_STATE_MAP=         # real 模式：整数 state 映射，默认 {"idle":[0],"occupied":[1],"faulty":[2]}
                         #   海乐真实接口实测为 {"idle":[1],"occupied":[2],"faulty":[3]}
SYNC_STALE_MS=30000      # 看板数据超过该毫秒数时，被请求即触发一次同步（默认 30s）
VAPID_PUBLIC_KEY=        # Web Push 公钥（base64url）
VAPID_PRIVATE_KEY=       # Web Push 私钥（base64url）
VITE_API_BASE=           # 前端接口根（默认同源；本地开发用 http://localhost:8787）
```
VAPID_SUBJECT=mailto:dev@weshirt.local
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=
DINGTALK_ROBOT_CODE=
DINGTALK_AGENT_ID=
DINGTALK_AES_KEY=
DINGTALK_TOKEN=
DINGTALK_WEBHOOK=        # 自定义机器人 webhook（群广播，不计 API 配额）
BUILDING_ID=b1           # 默认楼栋
```

> **安全约定（2026-10-26 加固）**：密钥不再有内置默认值。
> 以前 `AUTH_SECRET || 'dev-secret'` 意味着线上漏配一个变量，
> 任何人都能用公开常量伪造任意 userId 的 token；`ADMIN_TOKEN || 'admin123'` 同理。
> 现在缺配置就 fail-closed（401/503），宁可挂掉也不要用可猜的默认值。

## 2. 模块接口（必须逐字实现）

### 2.1 `packages/core/util.js`（主控已写，直接用）

```js
export function json(data, status = 200, headers)
export function apiErr(code, message, status = 400)
export function nowISO()
export function minutesBetween(fromISO, toISO)   // 可能为负
export function safeJson(str, fallback = null)
export function randomCode(len = 6)              // 数字字符串
export function pick(obj, keys)
```

### 2.2 `packages/core/store.js`（Agent Backend）

```js
export function createMemoryStore()
export function createFileStore(dir)   // JSON 落盘，节流写盘
export function createEdgeKVStore(kv)  // EdgeOne KV binding 适配
// 统一接口（所有实现）：
//   await store.get(key, fallback = null)   // 值为任意 JSON
//   await store.put(key, value)             // 覆盖写
//   await store.del(key)
//   await store.list(prefix)                // → [{ key, value }]
```

### 2.3 `packages/core/auth.js`（Agent Backend）

```js
export function newUserId()                        // 短 id，如 "u_" + 10 位 base36
export async function issueToken(userId, secret)   // HMAC-SHA256，格式 "<userId>.<ts>.<sig>"
export async function verifyToken(token, secret)   // → userId | null（过期 90 天）
export async function hashPassword(pw)             // PBKDF2 → "salt:hash"（V2 用，可 stub）
```

### 2.4 `packages/core/haier.js`（Agent Scraper）

```js
export const MOCK_MACHINES  // 数组，≥12 台，3 个 floorCode
export function createHaierClient(env)              // env: 环境变量对象
//   返回 { mode, fetchStatus(): Promise<RawMachine[]> }
//   mode==='real'：
//     A. 配置了 env.HAIER_POSITION_ID（推荐，已实测）→ 多点位流程：
//        1) GET  {HAIER_URL}/position/floorCodeList?positionId=<pid>   → data: ["1","4"]
//        2) GET  {HAIER_URL}/position/positionDevice?id=<pid>          → data: [{categoryCode, categoryName, total, idleCount}]
//        3) 对 楼层 × 类别 的组合 POST {HAIER_URL}/position/deviceDetailPage
//           body: { positionId, floorCode, categoryCode, page, pageSize }
//           → data: { page, pageSize, total, items: [{ id, deviceId, name, imei,
//                     floorCode, state, finishTime, enableReserve, reserveState }] }
//           单组合内按 page/pageSize 翻页直到取满 total
//        4) 用 env.HAIER_STATE_MAP 归一化后返回（已归一化，调用方再 normalize 为幂等空操作）
//        state 实测语义：1=空闲（finishTime 为空）、2=运行中（finishTime 为结束时刻）、3=故障/离线
//     B. 未配置 HAIER_POSITION_ID → 旧版单接口：POST env.HAIER_URL，body 为
//        { ...HAIER_PAYLOAD, page, pageSize }，期望 { code:0, data:{ total, items[] } }
//   mode==='mock' 返回 MOCK_MACHINES 的浅拷贝（每次调用让 1~2 台机器状态/剩余时间自然演进，便于看板演示）
//   real 模式失败时抛错，由调用方决定保留旧状态
//   id 取 deviceId（无则回退 id），保证跨次轮询稳定
export function normalizeMachines(raws, stateMap = { idle: [0], occupied: [1], faulty: [2] })
//   → [{ id, name, floorCode, state: 'idle'|'occupied'|'faulty'|'unknown', finishAt: ISO|null }]
export const DEFAULT_STATE_MAP
```

### 2.5 `packages/core/machines.js`（Agent Scraper）

```js
export function computeLeftMin(finishAt, nowISOstr)      // → 整数分钟，null 安全
export function buildBoard(machines, { buildingId, buildingName }) 
//   → { buildingId, buildingName, updatedAt, total, idle, occupied,
//       floors: [{ code, machines: [{...machine, leftMin, stateSince?}] }] }
export function diffEvents(prevMachines, nextMachines)
//   → [{ type: 'becameIdle'|'started'|'fault', machine }]
```

### 2.6 `packages/core/dingtalk.js`（Agent DingTalk）

```js
export function parseCommand(text)          // → { cmd: 'bind'|'unbind'|'status'|'on'|'off'|'help'|null, arg }
export function verifyAndDecryptCallback({ headers, body, aesKey, token })
//   钉钉回调：取 msg_signature/timestamp/nonce → 计算签名 → AES-256-CBC 解密
//   → { plain: {...}, ok: boolean, err?: string }
//   注：aesKey 为 43 字符 base64（末尾会补 '='），IV = aesKey 前 16 字节
export function createDingTalk(env)
//   { getToken(): Promise<string|null>
//     sendSingle(userId, text): Promise<{ok, err?}>        // 机器人单聊 oToMessages/batchSend
//     sendWorkNotice(userIds[], text): Promise<{ok, err?}> // 工作通知 asyncsend_v2
//     createTodo(userId, {subject, description, doneUrl}): Promise<{ok, taskId?, err?}>
//     replyWebhook(sessionWebhook, text): Promise<{ok, err?}> // 回调内的 sessionWebhook 免 token 回复
//     broadcast(text): Promise<{ok, err?}>                  // 自定义机器人 webhook 群广播
//   }
//   未配置凭证时全部返回 { ok:false, err:'not_configured' }，并在 console.warn 一次
export function buildBindReply(staffId, user, ok)     // 纯函数，生成回复文案
export function buildStatusReply(board)               // 群内「查」的回复文案（各楼层空闲数）
```

### 2.7 `packages/core/webpush.js`（Agent Push）

```js
export async function generateVapidKeys()             // → { publicKey, privateKey } base64url
export function createWebPush(env)
//   { async send(subscription, payloadObj): Promise<{ok, status?, gone?: boolean, err?}> }
//   RFC 8291 aes128gcm：ephemeral ECDH(P-256) + HKDF(SHA-256) + AES-128-GCM
//   RFC 8292 VAPID：ES256 JWT（aud/exp/sub），Authorization: vapid t=...,k=...
//   仅用 Web Crypto（crypto.subtle），不得依赖 node:crypto 专属 API
//   gone===true 表示 404/410，调用方应删除该订阅
```

## 3. HTTP API（全部 `/api` 前缀，JSON）

统一错误：`{ error: { code, message } }`，HTTP 4xx/5xx。
鉴权：`Authorization: Bearer <token>`（除公开接口）。

| 方法 | 路径 | 入参 | 出参 | 鉴权 |
|------|------|------|------|------|
| POST | `/api/auth` | `{ device }` 设备密钥（32+ 位十六进制，首次不带则新建） | `{ token, user }` | 公开 |
| GET | `/api/auth/me` | - | `{ user }` | ✅ |
| POST | `/api/auth/claim` | `{ code }` 一次性取回码（5 分钟、单次） | `{ token, user, merged? }` | 公开 |
| POST | `/api/auth/takecode` | `{ code }` 取回码换身份 | `{ token, user }` | 公开 |
| GET | `/api/dingtalk/login-url` | - | `{ url }` 钉钉授权地址 | ✅ |
| GET | `/api/dingtalk/oauth-callback` | `?code&state` | 302 → `/#/settings?ding=<flag>[&k=<claim>]` | 公开 |
| GET | `/api/machines` | `?building=b1` | `{ board }`（结构见 2.5） | 公开 |
| GET | `/api/tasks` | - | `{ tasks: [{ id, machineId, machineName, startAt, endAt, leftMin, done }] }` | ✅ |
| POST | `/api/tasks` | `{ machineId, mode?: 'machine'\|'duration', minutes?, note? }`。`mode='machine'` 按该机器 `finishAt` 算提醒时间（默认推荐）；否则洗衣机 `minutes ∈ 30/42/50/70`，烘干机 `10~180`。机器必须存在于看板（看板为空时不校验）。 | `{ task }` | ✅ |
| POST | `/api/tasks/:id/take` | - | `{ ok, task }`，标记 done + takenAt 并清自己的占用 | ✅ |
| POST | `/api/auth/takecode` | - | **已下线**，固定 410 | - |
| DELETE | `/api/tasks/:id` | - | `{ ok: true }` | ✅ |
| POST | `/api/user/notify` | `{ on?, leadMin? }` leadMin ∈ 0/3/5/10 | `{ user }`（含 `notifyOn`、`notifyLeadMin`） | ✅ |
| POST | `/api/user/profile` | `{ nick?, avatar? }` nick 1-16 字，avatar ∈ `av1`..`av12` | `{ user }` | ✅ |
| GET | `/api/user/random` | `?field=both\|nick\|avatar` | `{ nick, avatar }`（不落库，前端选了再 POST profile） | ✅ |
| GET | `/api/push/key` | - | `{ key, enabled }`（VAPID 公钥，前端订阅用） | 公开 |
| POST | `/api/push/subscribe` | `{ subscription }` | `{ ok: true }` | ✅ |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | `{ ok: true }` | ✅ |
| POST | `/api/push/test` | - | `{ sent, failed }` | ✅ |
| POST | `/api/marks` | `{ machineId, note? }` | `{ ok, expiresAt }` | ✅ |
| POST | `/api/faults/recover` | `{ machineId }` | `{ ok, recoveredAt }` | ✅ |
| GET | `/api/messages` | `?building=b1` | `{ messages: [...] }` | 公开 |
| POST | `/api/messages` | `{ text }` | `{ message }` | ✅ |
| GET | `/api/notices` | `?building=b1` | `{ notices: [...] }` | 公开 |
| POST | `/api/bindcode` | - | `{ code, expiresAt }` | ✅ |
| POST | `/api/dingtalk/callback` | 钉钉原始回调 | `{ errcode: 0 }` 或加密响应 | 公开（验签） |
| POST | `/api/admin/config` | `{ adminToken, key, value }` | `{ ok }` | 口令 |
| GET | `/api/mapping` | `?building=b1` | `{ mapping, updatedAt }` | 公开 |
| POST | `/api/mapping` | `{ building?, mapping }` | `{ ok, mapping, updatedAt }` | 口令（`X-Admin-Token`） |
| GET | `/api/admin/status` | `X-Admin-Token` 头（或 `?token=`）、`?building=b1` | 见下 | 口令 |
| GET | `/api/health` | - | `{ ok: true, mode }` | 公开 |
| GET | `/api/debug/storage` | `?token=<ADMIN_TOKEN>` | `{ store:{kind,name}, wrote, previousAt, hits, persistent, hint }` | 口令 |
| POST | `/api/admin/purge-test` | `?token=<ADMIN_TOKEN>`，`apply=1` 才真正落库 | `{ applied, testUserIds, messages, occupancy, queue, tasks, users, uuidMappings, probe }` | 口令 |
| ALL | `/api/cron/sync` | `X-Admin-Token` 头（或 `?token=`） | `{ fetched, events, notified }` | 口令（必填） |
| GET | `/api/admin/audit-logs` | `?days=7&type=&level=&actor=&q=&limit=` | `{ total, days, events, types }` | 口令 |
| GET | `/api/admin/audit-logs.csv` | 同上（`limit` 固定 500） | CSV（UTF-8 BOM） | 口令 |
| POST | `/api/admin/audit-logs/prune` | `?keepDays=30&apply=1` | `{ applied, candidates, removed }` | 口令 |
| GET | `/api/admin/notify-check` | - | `{ configured, channels, callbacks, boundUsers, hint }` | 口令 |
| POST | `/api/admin/notify-test` | `?to=self\|group\|both` | `{ dm, group }` | 口令 |
| POST | `/api/admin/reset-callback-stats` | `?group=1` 连群会话一起清 | `{ ok, groupCleared }` | 口令 |

`user` 结构：`{ id, nick, avatar, createdAt, dingBound, dingUserId, notifyOn, notifyLeadMin }`。

`avatar` 是**头像 key**（`av1`..`av12`），不是 emoji、也不是图片 URL——图形由前端
`components/Avatar.vue` 用 SVG 程序化绘制。后端存 emoji 的历史数据会在读取时
由 `normalizeAvatar()` 稳定映射到某个 key，保证同一用户头像不会乱跳。

`GET /api/debug/storage` 用来确认线上是否真的绑定了 KV。`persistent:false` 意味着
数据只活在一个请求里（表现为「刚写的东西下次读不到」），需要在控制台给项目绑定 KV 命名空间。
线上已绑定，正常响应是 `store.kind = "kv"`、`name = "globalThis.LAUNDRY_KV"`、`persistent = true`。

`POST /api/admin/purge-test` 是一次性运维接口，**只删明显是测试的数据**：文案命中
`回归测试|本地测试|线上测试|持久化验证` 的留言、昵称命中测试名单的用户所产出的占用/排队/任务，
以及这些用户的 `user:*`、`tasks:*`、`userByUuid:*` 映射和 `probe:last` 探针。
默认 dry-run（只回报计数），必须带 `apply=1` 才真正落库。跑回归测试**不要直接打生产**——
要用它把痕迹清干净，或者干脆换一个临时项目。

`GET /api/admin/status` 返回（口令错误 → 403）：

```json
{
  "ok": true,
  "mode": "real",
  "building": { "id": "b1", "name": "示例学校" },
  "haier": { "positionId": "<position-id>", "base": "https://yshz-user.haier-ioc.com" },
  "dingtalk": { "configured": false, "robot": false, "webhook": false, "callback": false },
  "sync": { "lastFetchAt": "ISO", "failCount": 0, "lastError": null },
  "board": {
    "total": 36, "idle": 10, "occupied": 24, "faulty": 2, "updatedAt": "ISO",
    "floors": [{ "code": "1", "total": 35, "idle": 9, "occupied": 25, "faulty": 1 }]
  },
  "counts": { "notices": 0, "messages": 3, "users": 5 }
}
```

`board` 为 `null` 表示尚未同步成功；`sync` 为 `null` 表示从未同步。

**机位绑定**（`GET/POST /api/mapping`）：把 3D 场景里的固定机位号映射到真实设备。

```
机位 key 固定为： "1" "2" "3" "4" "5" "6" "7" "D1" "D2"
mapping 值：真实设备的 deviceId 字符串，或 null（未绑定）
```

```json
{ "mapping": { "1": "demo-washer-1", "D1": "demo-dryer-1", "D2": null }, "updatedAt": "ISO" }
```

POST 时校验：key 必须在上述集合内；value 必须为 `null` 或当前看板里存在的 deviceId，否则返回 `bad_param`。

## 4. 数据存储 key 规范（Store 逻辑 key）

```
meta:sync          { lastFetchAt, failCount, lastError }
meta:haier         { url, headers, payload, stateMap }   // 管理页可覆盖 env
meta:dingtalk      { appKey, appSecret, robotCode, agentId, aesKey, token, webhook, accessToken, tokenExpAt }
machines:{building}  { board, rawUpdatedAt }
mapping:{building}   { mapping: { "1":"deviceId", ..., "D1":null }, updatedAt }   // 机位 ↔ 真实设备
user:{id}          { id, nick, createdAt, takeCode, pwHash?, dingUserId?, karma, notifyOn?, notifyLeadMin? }
userByDing:{staffId}  userId 字符串（反查）
bindcode:{code}    { userId, expAt }
tasks:{userId}     [ { id, machineId, machineName, startAt, endAt, done, notified } ]
subs               [{ userId, endpoint, keys, createdAt }]  // Web Push 订阅列表
marks:{machineId}  { userId, note, expAt }
faults:{building}   { [machineId]: { state: 'recovered', userId, recoveredAt } }  // 二次确认后忽略海乐故障，可再上报
messages:{building} [ { id, userId, nick, text, at } ]      // 最多 100 条
notices:{building} [ { id, title, body, at, pin } ]
```

## 5. 前端约定（Agent Frontend）

- 路由：`/` **3D 洗衣房（默认首页）**、`/list` 列表看板、`/display` 大屏、`/task` 我的洗衣、`/settings` 设置（含钉钉绑定）、`/board` 留言板、`/admin` 管理
- **3D 洗衣房空间规则（现场物理位置，改动需确认）**：
  - 视角：站在洗衣房门口面向房间内部（相机朝 -Z），近处 = +Z
  - **右手边（+X）从近到远 = 烘干机 D1、洗衣机 1、2、3、4**
  - **左手边（-X）从近到远 = 开水机、烘干机 D2、洗衣机 7、6、5**（开水机比 D2 更靠近门）
  - 机位 key 固定为 `1`–`7`、`D1`、`D2`（对应 `1F-01`–`1F-07`、`1F-D1`、`1F-D2`）
  - 状态视觉语义：**绿 = 空桶用**、**黄 = 桶内衣物在翻滚（占用）**、**红 = 桶内 X（故障）**；同时体现为舱门色环、顶部状态灯带、上方编号牌三处
  - 固定设施：后墙四扇推拉窗；**进门同墙（门框墙）右侧墙垛上的电闸箱**；进门左侧（D2 边）开水机；每台机器后方有投放装置（黑色长条盒）、正下方并排两盒液体（洗衣液蓝 / 除菌液绿）、墙面水龙头与两根自然下垂的软管
  - `?view=back` 可从房间内部回看门口（验证门框/电闸）
  - 相机 FOV 按视口宽高比自适应（`fitCamera`），保证竖屏下两排机器都在画面内；three.js 走路由懒加载（独立 chunk），不得进入首屏包
- 主题：深色优先（宿舍夜间场景），CSS 变量集中在 `src/styles.css`
- 状态色：空闲 `#22c55e`（绿）、占用 `#f59e0b`（橙）、故障 `#ef4444`（红）、未知 `#6b7280`
- 数据源：`src/api.js` 统一封装，`VITE_API_BASE` 可配，默认 `http://localhost:8787`
- 轮询：看板 25s，大屏 15s；页面隐藏时暂停（`document.visibilityState`）
- 移动端优先，375px 起；Vant 4 组件库
- 所有文案中文；不引入任何统计 SDK

## 6. 双形态适配（Agent Backend）

- `server/app.js`：Hono app，挂载以上全部路由与定时同步函数 `runSync(env)`（纯函数，可被 cron 与手动接口复用）
- `server/index.js`：`@hono/node-server` 起服务 + `setInterval` 每 60s 调 `runSync` + FileStore
- `functions/[[default]].js`：`export function onRequest(context)` → 首次请求时初始化 EdgeKVStore 并 `app.fetch(context.request)`
- `functions/api/cron/sync.js`：`export function onScheduled(context)` → 调 `runSync`
- EdgeOne 环境变量通过 `context.env` 传入，与 Node 的 `process.env` 合并成统一 `env` 对象

## 2026-11-09：住宿楼偏好、设备类型与通知行为

- 用户资料新增 `dormBuilding: null | "guiyuan" | "liuyuan" | "meiyuan" | "zhuyuan"`，依次表示桂园、柳园、梅园、竹园。`POST /api/user/profile` 接受该字段；未知值返回 400，未登录返回 401，不能写入临时重建用户。其他资料修改保留此偏好。
- `BUILDING_ID` / `machines:b1` 仍是既有看板分区，住宿楼偏好用于筛选全校快照，不据此创造新的 KV 分区。首次选择保存在本机，登录用户同时保存到个人资料；设置页可切换。桂园复用已确认的 3D 机位，其他楼使用列表，避免虚构物理布局。
- 看板机器增加可信 `kind: "washer" | "dryer"`。后台机位绑定的 D 编号决定烘干类型，不能只按名称或客户端声明判断。烘干登记允许 10–180 整数分钟；洗衣仍为 30/42/50/70 分钟。
- 自动群播报关闭：状态变化、疑似跳闸、催取衣均不再向群发送。个人通知遵守 `notifyOn`，保留主动查询回复及管理员显式通道测试。明文未认证回调不得认领或完成他人任务。
- 查询保留完整上次成功快照，部分上游请求失败不发布残缺新快照；统一前端公开看板查询及短缓存/在途去重，保留后台故障修正与估时语义。

## 2026-11-09 第二轮：楼栋看板与遥测

- `GET /api/machines?dorm=guiyuan|liuyuan|meiyuan|zhuyuan` 在服务端按住宿楼筛选，返回 `{ board, mapping }`；`board.dormBuilding` 为所选编码，统计只计当前楼。省略 dorm 仍供后台取完整快照，非法值返回400。`building`仍是旧KV分区；不能将住宿楼code当作KV分区。
- 机器返回 `dormBuilding`、`kind`、`slot`、`displayName`；人工桂园机位绑定优先，其次设备明确住宿楼，最后名称归属；无法确认归属的设备不混入任意楼。`GET /api/admin/status` 增加 `dormBuildings:[{code,name,total,idle,occupied,faulty,unknown}]`。
- `POST /api/telemetry` 公开接收 `{events:[{name,route,dorm,...白名单数值/枚举}]}`，每批最多20、正文16KiB；仅接受 page_view / api_request / web_vital / client_error / room_performance / room_interaction / dorm_select。服务端去掉任意额外字段，时间以服务端为准，不存用户ID、IP、凭据、查询参数、消息正文或错误堆栈。
- 遥测按天/楼栋聚合，最多保存14天，单日事件数有上限；浏览器批量发送并限制队列，失败不影响主业务。尊重浏览器Do Not Track及本机关闭设置。
- `GET /api/admin/telemetry?days=7&dorm=code` 必须后台鉴权，days为1–14，返回 `{days,received,pageViews,errors,api:{count,failed,avgMs,p95Ms},vitals:{lcpMs,cls,inpMs},room:{samples,avgFps,avgDrawCalls,avgTriangles,quality:{}},routes:[{route,views}],buildings:[{code,count}],recentErrors:[{at,route,kind,status?}],retentionDays:14}`。接口耗时为采样请求，INP为浏览器交互延迟近似值，不用于识别个人或推算准确活跃人数。
- 任务倒计时到点只描述计时结束；实际机器空闲事件才明确设备已结束，洗衣与烘干文案分别表达，并给出取衣确认入口。

## 2026-11-09 第三轮：运营、朋友与助手

- 最新群播报规则覆盖此前关闭规则：北京时间8:00–22:00每小时检查一次，机器有意义状态相对上次成功播报未变则跳过，倒计时自然减少不算变化。不单独向群播报催取或疑似故障；后台可配置时段。连续独立同步样本复核故障及恢复，过期/未知样本不累计；疑似未取与故障分别表达。
- `GET/POST/DELETE /api/queue`兼容原排队字段，预约增加预计开始/结束时间和估计标记，基于机器结束时间及前序队列时长计算；取消只允许本人。`GET/POST /api/messages`支持dorm/machine筛选、分页和replyTo；`DELETE /api/messages/:id`只允许本人。内容长度及频率受限。
- `GET/PATCH /api/admin/operations`、`PATCH /api/admin/operations/alerts/:id`需管理员鉴权，提供运营配置、去重告警、已读/解决状态及通知投递结果。
- `/api/social`及子路径除邀请预览外需要用户认证。`POST /invite {kind:friend|share}`生成短期签名票据，`GET /invite?ticket=`只返回脱敏预览，`POST /accept {ticket}`显式确认双向好友，share不自动绑定。
- `POST /api/social/contact {toUserId,template}`只允许联系当前占用者或好友；template只允许forgot/misplaced/taken_wrong/left_behind。首条只能服务端固定模板，每对用户24小时最多一条待确认邀请。`POST /threads/:id/accept`仅收件人确认后解锁双向自由文本；读取/发送/屏蔽均校验参与者，限制长度、频率和历史条数。
- `POST /api/social/pickup {friendId,taskId}`只允许请求真实好友代取本人的未完成任务；`GET /pickups`仅返回当事人可见任务与当前剩余时间；`POST /pickups/:id/respond {action:accept|reject|complete}`约束收件人及状态，完成时只清除该任务的占用。对方收到个人钉钉通知，我的洗衣展示受托任务。个人二维码只含短期票据，不含凭据。
- 助手`/api/assistant/*`需用户认证，`GET/PATCH /api/admin/assistant`需管理员认证；自定义Responses兼容端点、模型、密钥仅服务端使用，未配置则不可调用。默认每日20次、每分钟3次、每人并发1，请求及输出长度、超时和工具轮数有上限，调用store:false。模型仅可读本人住宿楼机器状态，不直接执行发信或代取。
- `GET/PATCH/DELETE /api/assistant/memory`提供用户可控记忆开关、简短偏好与删除，习惯仅从本人洗衣时间推导；上下文有期限和条数上限。Skills为可查看、创建、分享和确认导入的提示模板，不执行任意脚本。`POST /api/mcp`提供认证且限流的JSON-RPC initialize、tools/list及只读get_machine_status工具，楼栋范围取当前用户资料。
- 哈希静态资源长期immutable缓存；HTML和service worker重验证，API/身份信息不进入静态缓存。公开看板按楼共享在途查询及短缓存，失败保留有时间标记的最近成功快照；隐藏页面停止轮询，回到前台按缓存新鲜度刷新。

## 网站设置、公告与预约提醒补充

- `GET /api/site`仅返回公开站名、图标、楼栋分类；学校ID和钉钉凭据仅在后台管理。`GET/PATCH /api/admin/site`管理站点，最高管理员可添加真实用户管理员角色、写入钉钉密钥（只写不读）。楼栋分类允许自定义编码，用户偏好和机器归属按当前目录验证。
- `GET /api/announcements?dorm=`仅返回已发布且处于有效时间的公告；管理员读/写/删公告在`/api/admin/announcements`，编辑以版本号避免覆盖。正文Markdown最多20000字，浏览器渲染经DOMPurify清理。`GET/PATCH /api/user/announcements`保存接收开关及不再提醒的公告版本。普通退出仅当前会话关闭，公告升级后可重新提醒。
- 排队队首在当前机器预计结束前3分钟及结束时各接收一次页内通知和钉钉提醒，取消即停止，投递失败有界重试；预计时间与机器确认结束分别表达。`GET /api/queue/notices`和`POST /api/queue/notices/:id/read`仅本人可读写。
- 登录state/claim票据分别具备明确role；claim绑定原设备密钥和一次性nonce，同store实例串行消费；不得使用分享或管理员票据兑换用户身份。

### 上游配置诊断

`GET /api/upstream-info` 仅允许最高管理员，返回 `Cache-Control: no-store`。用户页面统一使用按住宿楼筛选的 `/api/machines` 快照，不暴露学校或点位配置。

## 洗衣登记记录补充

- `POST /api/tasks` 新增可选字段 `note?: string` 和 `useDisinfectant?: boolean`。备注最多 200 字；消毒液标记省略时为 `false`。非字符串备注、超长备注或非布尔消毒液标记均作为无效参数拒绝，不能静默截断或将字符串转换成布尔值。
- 任务记录保存并在本人的任务信息中返回备注及消毒液标记；旧任务缺失字段时按空备注和 `false` 展示。备注不自动发布到公开留言板。
- 两个字段仅记录用户填写的信息，不代表机器检测结果，不控制机器、不触发消毒液投放，也不改变运行时长、程序或通知规则。

## 身份、社区与巡检扩展

- `note`、`useDisinfectant` 与新增 `selfCleaned?: boolean` 均为公开的本次洗衣记录；当前有效占用通过 `/api/occupancy` 的 `care: {note,useDisinfectant,selfCleaned,source:"user_report"}` 返回。备注用纯文本显示，并注明用户记录，不代表传感器检测；取衣或占用结束后清除，历史任务列表仍仅本人可读。登记表在提交前明确提示公开范围。
- 公开频道 `public` 与动态楼栋频道分离；公共频道和本人住宿楼优先。身份标识来自 `meta:siteAdmins`，不能由消息内容或请求字段自授。总管、管理员具备留言删除、限时/永久禁言和志愿管理留言置顶权限。
- 志愿管理按楼栋授权；巡检上传压缩照片、状态和备注，异常通过后台指定的本楼钉钉群发送。普通巡检不广播，重复异常限频并记录实际投递结果。巡检照片只对授权管理人员提供，不进入公开留言。
- 设置底部展示用户授权提供的微信赞赏码和关于文案，图片重新编码以去除原始元数据。

## 细粒度授权、资料一致性与请求追踪

- `GET /api/user/permissions` 返回当前有效身份、`adminVisible` 和每项功能的 `view/operate/viewBuildings/operateBuildings`。`null` 表示全部楼栋，`[]` 为空范围；操作范围必须包含于查看范围。身份为能力上限，总管在 `/api/admin/permissions` 查询成员并通过 `PATCH /:id {permissions}` 覆盖或 `DELETE /:id` 恢复默认；总管及部署入口保留恢复能力。后台入口仅在当前有效管理查看权存在时显示。
- 范围限制在服务端验证目标并过滤列表；限定楼栋的管理员不能执行无目标的全局批量操作。全局网站、模型、系统及运营配置不接受楼栋范围设置。身份撤销和个人规则更改使旧幂等响应失效。公开看板仍公开，个人查看规则不是隐藏公开设备数据的安全边界。
- 资料读空返回可恢复的 `409 account_out_of_sync`，不生成临时账号或随机昵称覆盖缓存；前端忽略旧账号和旧版本响应。用户界面不显示内部 ID，管理定位仍使用稳定服务器 ID。
- 所有 API 响应带 `X-Event-ID`；HTTP 错误为 `{error:{code,message,status,eventId}}`，5xx 不返回异常堆栈或配置。前端保留错误属性并展示状态码与事件 ID；网络失败使用 `client_` 事件 ID 和状态 `0`，表示请求未获得可关联的服务端响应。
- 普通已登录 JSON 写请求可使用 `Idempotency-Key`，相同账号、请求与标识仅执行一次，不同正文复用标识返回409；前端并发同内容共用请求，网络失败重试保留标识。回复最多缓存2分钟、每用户12条；上传、认证和系统触发等不参与通用回复缓存。
- 业务写操作及后台敏感读取、导出记录操作者、路由模板、目标、结果、状态码和事件 ID，不记录正文、查询凭据、照片、私聊或密钥。普通轮询与匿名遥测不产生身份审计。日志按天500条环形保留，默认30天有限清理；运行时互斥避免同实例写覆盖。跨 Edge 节点的严格事务仍需强一致存储或单写入协调，不能宣称全局事务或绝对零丢失。
