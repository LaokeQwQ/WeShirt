# WeShirt

[中文](README.md) · **English**

A mobile web dashboard for dorm laundry rooms, with personal reminders and pickup coordination. Check available machines before carrying your laundry downstairs.

The recommended deployment is a **fully cloud-hosted SaaS setup on Tencent EdgeOne Pages and Tencent CloudBase**. EdgeOne Pages serves the frontend, Edge APIs and persistent KV storage. CloudBase periodically invokes the protected sync endpoint. This avoids maintaining your own server and reduces reliance on a single machine.

WeShirt reads publicly available Haile Life machine status. It does not start machines, process payments or remotely control equipment. Availability and delivery still depend on the cloud platforms, network and upstream services.

## Features

- **Dorm preference and dashboard:** remember the first selection, sync it after login, and browse machines by dorm in 3D or list views.
- **Wash and dry tasks:** countdowns, advance reminders, pickup confirmation and public notes/disinfectant/self-cleaning records; drying supports 10–180 minutes, with a 60-minute default.
- **Favorites and usual laundry times:** weekday and time-window reminders for idle favorite machines, at least 30 minutes apart, up to three successful reminders per window; registering a task stops that occurrence.
- **Queues and messages:** position, estimated availability, cancellation, reminders for the machine's queue head near three minutes before completion and at the end stage, public and dorm channels, replies, identity badges and moderation.
- **Friends and pickup help:** QR invitations, mutual acceptance, contacting the current occupant and pickup requests.
- **Personal notifications:** DingTalk and browser Web Push; faults require repeated confirmation, and suspected uncollected laundry is a separate state.
- **Site administration:** branding, school and dorm settings, member permissions, scoped volunteer inspections, Markdown announcements, hourly group summaries, alerts and performance statistics.
- **Optional AI assistant:** restricted machine queries, user-controlled memory and prompt templates, with credentials stored only on the server.

Group summaries are checked hourly from 08:00 through 22:00 Beijing time by default and skipped when meaningful states have not changed. Estimates and queues help coordinate use; confirm conditions on site.

## Quick start

### Fully cloud-hosted deployment

1. Import the repository into Tencent EdgeOne Pages and select `master` as the production branch. Build with `npm ci && npm run build` and publish `dist`.
2. Set server-side `AUTH_SECRET` (at least 16 characters) and `ADMIN_TOKEN` (at least 8 characters), then create and bind persistent KV storage.
3. Deploy the APIs and frontend, then configure the data source, DingTalk and site settings in the admin panel.
4. Deploy the [sync trigger](tools/cloudbase-fn/weshirt-sync-ping/README.en.md) on Tencent CloudBase. Set its endpoint and key through environment variables and schedule checks at least once per minute where supported.

See [Deployment](docs/DEPLOYMENT.en.md) for the complete setup, storage responsibilities, local development and optional private Node hosting.

### Local preview

Requires Node.js 22 and npm:

```bash
git clone https://github.com/LaokeQwQ/WeShirt.git
cd WeShirt
npm ci
cp .env.example .env
```

**Before starting, edit `.env` and set separate random values for `AUTH_SECRET` (at least 16 characters) and `ADMIN_TOKEN` (at least 8 characters):**

```bash
npm run dev
```

Open `http://localhost:5173`; the admin route is `/#/admin`. In PowerShell, use `Copy-Item .env.example .env`. Mock machines work without an upstream data source. Real DingTalk login and notifications require configuration. Empty secrets still allow the public mock dashboard to start, but login and administration reject requests.

## Documentation

| Document | Contents |
| --- | --- |
| [Configuration](docs/CONFIGURATION.en.md) | Environment variables, site settings, notifications, AI and status rules |
| [Deployment](docs/DEPLOYMENT.en.md) | EdgeOne Pages + CloudBase, KV, Node and operational checks |
| [Development and releases](docs/DEVELOPMENT.en.md) | Local work, tests, CI and `dev` → `master` |
| [Privacy and usage](docs/PRIVACY.en.md) | Data scope, telemetry, source publication and functional limits |
| [Sync and networking](docs/EGRESS.en.md) | Protected triggers, scheduling and upstream troubleshooting |

Each detailed document links to its Chinese counterpart.

## Acknowledgments

Thanks to [PA733 / Laundry-Status-Monitor](https://github.com/PA733/Laundry-Status-Monitor) for the groundwork and ideas around machine monitoring and notifications. The README organization takes inspiration from [xm2284 / jsnu-laundry-radar](https://github.com/xm2284/jsnu-laundry-radar).

The project uses the [MIT license](LICENSE). Third-party dependencies retain their own licenses.
