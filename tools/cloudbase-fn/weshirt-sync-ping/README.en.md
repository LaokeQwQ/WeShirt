# WeShirt sync trigger

[中文](README.md)

A scheduled trigger for deployments without a persistent process. It sends one POST request to the protected WeShirt sync endpoint. It does not query the machine upstream, submit raw machine data or need upstream accounts or an admin password.

## Setup

Upload `index.js` and `package.json` to Tencent CloudBase or another platform supporting Node.js CommonJS. No third-party dependencies are required. Use entry `index.main` and a platform execution timeout longer than 30 seconds.

Set these function environment variables:

| Variable | Value |
| --- | --- |
| `WESHIRT_SYNC_URL` | Your HTTPS site plus `/api/cron/sync`, such as `https://laundry.example.test/api/cron/sync` |
| `WESHIRT_SYNC_KEY` | The dedicated sync key obtained from WeShirt administration |

Use the sync key, not an admin password or user token. It is derived from server-side `AUTH_SECRET`; update the trigger after rotating that secret.

The endpoint must use HTTPS and the exact `/api/cron/sync` path. Queries, fragments and URL credentials are rejected. The key is sent only in JSON `{ "k": "..." }`, never as a URL query, log entry or scheduler parameter.

## Schedule

Where supported, schedule at least one check per minute. This gives three-minute advance and end-stage reminders an opportunity to be evaluated. A platform restricted to five-minute scheduling may miss the advance window. Status and delivery still depend on upstream responses and notification channels.

Each request has a 30-second total timeout, follows no redirects and does not retry within a run. The next scheduled invocation retries naturally. Limit platform-level retries and concurrency to avoid overlapping request storms.

## Results

HTTP success returns `{ "ok": true, "status": 200 }`. Failures return a fixed category and optional status: `missing_sync_key`, `invalid_sync_url`, `timeout`, `network_error`, `response_error`, `request_error` or `http_error`.

The function does not print configuration, secrets, full URLs or response bodies. Check admin sync timestamps and alerts to assess actual business health. Do not paste keys into public issues, screenshots or logs.

This trigger provides scheduled invocation and does not change the server's upstream network egress. When upstream access fails, the server retains the last complete snapshot and diagnostics; this function does not assemble or upload partial device lists.
