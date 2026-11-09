# WeShirt · 等衣

**中文** · [English](README.en.md)

面向宿舍洗衣房的状态看板、个人提醒与取衣协作工具。打开手机网页，先看空机、再安排洗衣。

推荐采用**腾讯 EdgeOne Pages + 腾讯 CloudBase** 全云端 SaaS 部署：EdgeOne Pages 承载静态页面、Edge API 与持久化 KV，CloudBase 定时触发受保护的同步接口。全云端托管、免自建服务器，降低单机故障风险。

本项目基于海乐生活公开设备状态数据提供服务，不提供机器启动、支付或远程控制。云端服务与通知仍依赖平台、网络及上游可用性。

## 功能

- **住宿楼绑定与看板**：首次选择后记住，登录后同步账号；按楼查询设备，支持 3D 和列表视图。
- **洗衣与烘干任务**：倒计时、提前提醒、取衣确认，公开洗衣备注与消毒液/自清洁记录；烘干支持 10–180 分钟，默认 60 分钟。
- **收藏与常洗时间**：按星期和时段提醒收藏机器空闲，成功提醒间隔至少 30 分钟，每次时段最多 3 条，登记后停止当次提醒。
- **排队与留言**：我的排位、预计可用时刻、取消预约、队首结束前约 3 分钟及结束阶段提醒，分楼频道与公共频道、回复、身份标识和禁言管理。
- **朋友与代取**：二维码邀请、双方确认、联系占用者与代取请求。
- **个人通知**：钉钉消息与浏览器 Web Push；故障二次复核，疑似未取与设备故障分别展示。
- **网站运营**：站名图标、学校与楼栋配置、后台成员权限与楼栋志愿巡检、Markdown 公告、整点群摘要、告警与性能统计。
- **可选 AI 助手**：受限机器查询、用户可控记忆与提示模板，密钥仅保存在服务端。

群摘要默认北京时间 8:00–22:00 每整点检查，状态未变时跳过。预计时间与排队用于协调，实际使用前请确认现场状态。

## 快速开始

### 全云端部署

1. 将仓库导入腾讯 EdgeOne Pages，生产分支选择 `master`，构建命令 `npm ci && npm run build`，输出目录 `dist`。
2. 配置服务端 `AUTH_SECRET`（至少 16 字符）、`ADMIN_TOKEN`（至少 8 字符），创建并绑定持久化 KV。
3. 部署 API 与页面，在后台配置数据源、钉钉及网站信息。
4. 在腾讯 CloudBase 部署 [同步触发器](tools/cloudbase-fn/weshirt-sync-ping/README.md)，通过环境变量设置同步地址与密钥，按平台能力至少每分钟检查一次。

完整步骤与存储职责见 [部署说明](docs/DEPLOYMENT.md)。Node 本地开发与可选私有部署也在那里说明。

### 本地体验

需要 Node.js 22 与 npm：

```bash
git clone https://github.com/LaokeQwQ/WeShirt.git
cd WeShirt
npm ci
cp .env.example .env
```

**先编辑 `.env`，填写独立随机的 `AUTH_SECRET`（至少 16 字符）和 `ADMIN_TOKEN`（至少 8 字符），再执行：**

```bash
npm run dev
```

打开 `http://localhost:5173`，后台为 `/#/admin`。PowerShell 可用 `Copy-Item .env.example .env`。默认模拟设备无需上游配置；真实钉钉登录和通知需另行配置。空密钥时公开模拟看板仍可启动，但登录和管理功能会拒绝请求。

## 文档

| 文档 | 内容 |
| --- | --- |
| [配置](docs/CONFIGURATION.md) | 环境变量、网站管理、通知、AI 与状态规则 |
| [部署](docs/DEPLOYMENT.md) | EdgeOne Pages + CloudBase、KV、Node 与运行验证 |
| [开发与发布](docs/DEVELOPMENT.md) | 本地开发、测试、CI、`dev` → `master` |
| [隐私与使用说明](docs/PRIVACY.md) | 数据范围、遥测、公开源码与功能边界 |
| [同步与网络](docs/EGRESS.md) | 受保护触发器、调度及上游故障定位 |

详细文档均附英文版本入口。

## 致谢

感谢 [PA733 / Laundry-Status-Monitor](https://github.com/PA733/Laundry-Status-Monitor) 的轮子支持，为设备状态监测与通知提供参考。README 内容组织参考 [xm2284 / jsnu-laundry-radar](https://github.com/xm2284/jsnu-laundry-radar)。

项目采用 [MIT 许可证](LICENSE)，第三方依赖遵循各自许可证。
