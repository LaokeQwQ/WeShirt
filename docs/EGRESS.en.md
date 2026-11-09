# Sync triggers and upstream access

[Home](../README.en.md) · [中文](EGRESS.md)

Machine normalization, complete-snapshot checks, fault confirmation and notification decisions live in the shared server sync flow. Frontend queries reuse server results. Schedulers only invoke that flow, avoiding separate scraper and notification implementations.

## Runtime options

The Node service syncs at startup and checks again on the schedule in `server/index.js`. Edge Functions have no persistent timer, so use a platform or external scheduler. Lazy refresh from visitors alone cannot ensure reminders continue after users close the site.

Use the repository's [protected sync trigger](../tools/cloudbase-fn/weshirt-sync-ping/README.en.md). It sends only:

```http
POST /api/cron/sync
Content-Type: application/json

{ "k": "<sync-key>" }
```

Set `WESHIRT_SYNC_URL` to the site's HTTPS sync endpoint and `WESHIRT_SYNC_KEY` to the dedicated admin-provided sync key. Do not put the key in URL queries or logs, and do not substitute the admin password. Update it after rotating the signing secret.

## Scheduling and reminders

Where the platform supports it, check at least once per minute. Three-minute advance reminders require evaluation within that window. Five-minute or longer intervals may miss it. Hourly group summaries are evaluated during the first ten minutes of configured Beijing-time hours, deduplicated per hour and skipped when meaningful states are unchanged.

The trigger has a 30-second total timeout, follows no redirects and does not retry within an invocation. The next scheduled check can retry. Control concurrency and retries if the platform also retries automatically. Use admin sync timestamps and delivery outcomes to assess operation.

## Diagnosing upstream failures

Check the latest sync time, consecutive failures and upstream diagnostics. Distinguish configuration errors, timeouts, authentication failures, rate limits and network errors. Match state mappings, location, headers and account configuration to the current interface. Credentials remain server-side.

The server combines sync requests for a partition, limits page concurrency and preserves the previous complete snapshot on failure. A successful subset of floors or categories must not be published as a complete device list. Stale data displays a pending-update state, and unknown data does not advance fault confirmation.

A trigger-only function does not change the Edge server's upstream network route. If a separate route is needed, use the [CloudBase fetch adapter](../tools/cloudbase-fn/weshirt-sync-ingest/README.en.md). It reuses the shared client, fetches a complete snapshot and forwards it to the same Edge processing flow. Do not publish legacy scripts containing real hosts, upstream credentials or raw responses.

## Local validation

The trigger has no third-party dependencies. Tests use mocked requests rather than real message or machine services. Run root `npm test` before publication, verify function environment settings and confirm admin sync timestamps advance automatically. Avoid printing request bodies or server diagnostic responses in shared logs.
