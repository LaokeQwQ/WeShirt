# CloudBase fetch-and-ingest adapter

[中文](README.md)

Use this when the device upstream is unreliable from Edge and CloudBase must fetch through its own egress. The function calls the shared `packages/core/haier.js` client and posts a complete snapshot to `/api/cron/ingest`. Server-side rules still produce the board, confirm health and send notifications. A ping-only function does not replace this data path.

## Build and deploy

Install the locked project dependencies, then run from the repository root:

```bash
node tools/cloudbase-fn/build-ingest.mjs
```

Upload `index.js` and `package.json` from `.cloudbase-build/weshirt-sync-ingest/` to CloudBase. Build with the project's required Node version; the generated dependency-free package targets Node.js 18 or later and uses entry `index.main`. Do not upload the source `index.mjs` alone: it imports shared repository modules. Ignore the build directory in Git.

## Environment

| Preferred name | Legacy alias | Purpose |
| --- | --- | --- |
| `WESHIRT_INGEST_URL` | `INGEST_URL` | HTTPS site URL ending exactly in `/api/cron/ingest` |
| `WESHIRT_SYNC_URL` | `SYNC_URL` | Optional same-origin `/api/cron/sync` fallback |
| `WESHIRT_SYNC_KEY` | `SYNC_KEY` | Dedicated sync key, sent only in the JSON body |

Nonempty preferred names take precedence. Both Edge URLs must have the same origin and exact paths, without queries, fragments or embedded credentials. Set the existing upstream options such as `HAIER_URL`, `HAIER_POSITION_ID`, `HAIER_HEADERS` and `HAIER_PAYLOAD`; their meanings match the main project. Real mode is enforced. The upstream URL must use HTTPS and a different origin from Edge. Upstream authorization headers are never sent to Edge.

## Execution and diagnostics

The platform timeout may be 40 seconds; the adapter has a 30-second total budget covering response bodies, ingest and fallback. Fetching gets at most 25 seconds to leave time for posting. Any failed floor, category or page, an empty snapshot, more than 500 machines or an invalid raw state prevents ingestion of partial data. `rawState` becomes integer `state`; ISO finish times are submitted as `finishTime` without applying the Beijing offset twice on the server.

After an upstream or ingest failure, one optional sync fallback is attempted only within the remaining budget. Otherwise the next scheduled run retries. The shared upstream client's bounded retries remain in effect. Limits are 1 MiB per upstream response, 64 KiB per Edge response and 4 MiB of responses per run. Redirects are rejected. A successful HTTP status with `ok:false` is a business failure.

Results include `mode`, `snapshotComplete`, `status` and `eventId`. Fallback retains the fixed-category `initialFailure` so it cannot hide a failed snapshot. Logs contain only fixed reasons, statuses and trace IDs, never headers, keys, raw exceptions or response bodies. Schedule at least once per minute where supported, limit concurrency and platform retries, and avoid duplicate timers for the same site.
