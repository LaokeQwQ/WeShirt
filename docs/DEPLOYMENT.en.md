# Deployment

[Home](../README.en.md) · [中文](DEPLOYMENT.md) · [Configuration](CONFIGURATION.en.md)

## Recommended: Tencent EdgeOne Pages + Tencent CloudBase

This fully cloud-hosted SaaS setup avoids maintaining your own server and reduces dependence on a single machine. Responsibilities are:

| Component | Responsibility |
| --- | --- |
| EdgeOne Pages | Host the `dist/` frontend and static assets |
| Edge Functions | Run `functions/api/[[default]].js` for Hono APIs, sync and notification decisions |
| Bound persistent KV | Store users, tasks, site settings, queues, snapshots and operational state |
| CloudBase scheduled function | Trigger sync, or fetch complete snapshots through a separate network route and forward them, so checks continue without visitors |

This setup does not use a CloudBase database. Edge server code handles notification decisions, fault confirmation and status normalization. Platform and upstream failures can still affect availability; managed hosting does not remove interruption risk.

Select **`master` as the EdgeOne Pages production branch**. Use `dev` only for previews, and promote changes through a `dev` → `master` pull request.

### 1. Build and API

Import the repository into EdgeOne Pages. Use `npm ci && npm run build` and output directory `dist`. Keep `functions/api/[[default]].js` as the sole `/api/*` function entry. Build with Node.js 22.18+ (22 LTS) or 24.11+; the older 22.11 runtime does not meet the current dependency requirements.

Existing Upload projects can continue using CLI uploads. Check out the promoted `master`, build in a separate directory and record the release commit. Keep production `.env` files outside the public source checkout. Uploading only `dist` does not include the API functions.

Inject server variables through the platform's supported function configuration. At minimum, set `AUTH_SECRET` and `ADMIN_TOKEN` as described in [Configuration](CONFIGURATION.en.md). Leave `VITE_API_BASE` empty for same-origin production. Use a stable custom HTTPS domain and update DingTalk callbacks.

Create and bind persistent KV storage, preferably as `LAUNDRY_KV`. The entry supports `context.env` and platform global bindings. Run the admin storage diagnostic and verify newly saved data across requests. An in-memory fallback without KV is for debugging only.

### 2. CloudBase sync trigger

Upload `index.js` and `package.json` from the [trigger directory](../tools/cloudbase-fn/weshirt-sync-ping/README.en.md). Use a Node CommonJS runtime with entry `index.main`; no third-party dependencies are required. Set the platform execution timeout above 30 seconds.

| Environment variable | Value |
| --- | --- |
| `WESHIRT_SYNC_URL` | Your site followed by `/api/cron/sync`, such as `https://laundry.example.test/api/cron/sync` |
| `WESHIRT_SYNC_KEY` | The dedicated sync key provided by administration |

The key stays in environment configuration and is sent in POST JSON `{ "k": "..." }`. Do not include query parameters, URL credentials or secrets in the endpoint. Do not substitute the admin password. Update the trigger key after rotating `AUTH_SECRET`.

Schedule checks at least once per minute where supported. A three-minute advance reminder requires a check within that window; a five-minute schedule may miss it. The trigger has a 30-second total timeout, does not retry within a run or follow redirects, and does not print configuration or response bodies. Also limit concurrency for any platform-level retries.

If an existing deployment relies on CloudBase for a separate upstream network route, use the [fetch adapter](../tools/cloudbase-fn/weshirt-sync-ingest/README.en.md). It reuses the shared client and forwards a complete snapshot to `/api/cron/ingest` only after every floor and category succeeds. Failed fetches preserve the previous data. Do not replace an existing fetch function with the trigger-only function. Keep credentials in CloudBase environment variables and retain the existing sync key and site address.

### 3. Verify the release

Check `/api/health`, the public board and admin storage status. Confirm that sync timestamps advance even with no page open. Then verify login, saved dorm selection, announcements and notification diagnostics. Send real tests only to intended recipients; avoid repeated group-message testing.

Refresh after changing settings to confirm persistence. Monitor trigger failure categories, sync failures and channel outcomes. HTTP success from the trigger means the request completed; use admin sync diagnostics to assess business health. Retain the previous production build and a data backup.

For DingTalk login diagnosis, request `/api/debug/dingtalk?credentialsOnly=1` with the admin header. This checks the deployed application credentials and outbound connectivity without sending messages or returning tokens. The original full diagnostic without this flag includes a robot probe. User authorization still requires a fresh real login to verify; older failures recorded only as `token` cannot identify the upstream cause.

## Caching and assets

Retain the rules in `edgeone.json`: long-lived caching for hashed `/assets/*`, `no-cache` for `/`, `/index.html` and `/sw.js`, and no static caching for `/api/*`. The service worker reuses only same-origin hashed assets and icons, up to 60 items; it does not provide a fully offline application.

Three.js loads by route. Verify 3D slots against the physical room. Unbound slots display an explicit empty state, and other dorms can use lists.

## Optional: private Node hosting

```bash
npm ci
npm run build
npm start
```

Set the required `.env` secrets first. `npm start` serves APIs only, not `dist/`. Use Nginx or Caddy to serve static files, proxy `/api/*` to the Node port and enable HTTPS. The frontend uses hash routing.

Node performs an initial sync and checks again on the schedule in `server/index.js`. Use a process manager, persistent `DATA_DIR` and backups. Multiple processes must not write the same FileStore. Multiple instances need a suitable shared storage adapter. Keep sync checks more frequent than reminder windows.

## Edge compatibility check

```bash
npx --no-install esbuild 'functions/api/[[default]].js' --bundle --format=esm --platform=browser --target=es2022 --outfile=./edge-check.mjs
```

Delete the output after checking. Keep Node-only modules outside the Edge core. Platform configuration may change; follow the current console and official documentation. See [Sync and networking](EGRESS.en.md) for diagnostics.
