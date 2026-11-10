# Development and releases

[Home](../README.en.md) · [中文](DEVELOPMENT.md)

## Local development

Use Node.js 22.18+ (22 LTS) or 24.11+, npm and the lockfile. Copy `.env.example` and set `AUTH_SECRET` (at least 16 characters) and `ADMIN_TOKEN` (at least 8 characters) before starting. Without secrets the public mock board remains readable, while login and admin requests are rejected.

```bash
npm ci
npm run dev
```

The frontend runs at `http://localhost:5173`, the API at `http://localhost:8787`, and administration at `/#/admin`. Mock machines are the default. Configure real login, data and messages through [Configuration](CONFIGURATION.en.md). The frontend centralizes `VITE_API_BASE`; leave it empty for same-origin production.

## Checks

```bash
npm test
npm run build
```

Tests use mocked APIs and local storage and must not contact real notification channels or machine services. Changes to login, roles, asynchronous switching, queues, reminder deduplication and persistence need appropriate regressions. Validate mobile layouts and list fallback. Refreshes and failures should preserve UI drafts.

Targeted role and inspection checks:

```bash
node --test tests/identity-roles.test.js tests/inspections.test.js tests/inspection-integration.test.js
```

Integration regressions must use the real `createApp` with signed user tokens. Cover admins managing volunteers only, account super-admins changing highest-level configuration, immediate disablement and revocation, actual machine dorm scope, private photo authorization and format/size limits, targeted-group failures and durable cooldowns. Stub DingTalk locally instead of testing with real group messages. Check retention and bounded photo cleanup; never convert a human inspection issue directly into a device fault.

Guests can read the public channel only. Regular users and volunteers can read and post in the public channel and their own dorm channel. Cross-dorm access for super-admins and admins remains subject to authorized scope. Task notes and disinfectant/self-cleaning flags form the active occupancy's public `care` record: render them as plain text and clear the public projection after pickup. Owner task history and private inspection photos have separate authorization and must not reuse public fields indiscriminately.

See [Deployment](DEPLOYMENT.en.md) for the Edge bundle check. Node and Edge share standard Web API modules in `packages/core/`; keep Node-only files isolated from Edge entries.

## Branches and production

`dev` is the integration branch and `master` is the production release branch.

1. Open feature PRs against `dev` and merge after tests and builds pass.
2. Verify login, dorm selection, public task records, queues, announcements, channel moderation, role scope, inspection photos and notifications in preview.
3. Open a production PR from this repository's `dev` to `master`. Other branches and same-named branches in forks cannot promote.
4. Merge after checks and human review, then build production from `master`. Repository workflows do not push to the main branch or deploy production automatically.
5. Check health, storage, sync and delivery outcomes after release. Retain the preceding build and a backup.

GitHub Actions uses the latest Node 22 LTS (at least 22.18), runs tests, builds the frontend and checks the Edge bundle. A JavaScript/TypeScript CodeQL workflow is included. Dependabot checks npm and Actions weekly and targets `dev`.

Configure branch protection or Rulesets to require checks such as `Tests and build` and `Promotion policy` on `master` and block direct pushes. The promotion policy reads trusted PR metadata through `pull_request_target`, without checking out PR source or reading secrets. Avoid duplicate CodeQL default and advanced configurations.

## Publishing source

Publish source, tests, lockfiles, build and CI configuration, sanitized templates and public documentation. Exclude `.env`, data, deployment caches, credentials, logs, personal information in screenshots, private handoffs and local Git-history snapshots. Dependencies, build output and generated Edge-check bundles are not source deliverables.

Use fictional dorms, reserved example domains and synthetic credentials for fixed fixtures. Do not reuse production location, device or account IDs. Keep API documentation aligned with implementation. CI does not need deployment credentials.

## Layout

| Path | Contents |
| --- | --- |
| `frontend/`, `public/` | Vue 3, Pinia, Vant, Three.js, icons and service worker |
| `packages/core/` | Shared business rules, states and channel implementations |
| `server/`, `functions/` | Hono, Node entry and Edge APIs |
| `tests/` | `node:test` regressions |
| `tools/` | Icons, VAPID and protected sync trigger |
| `.github/` | CI, code scanning, dependency updates and promotion policy |

After promotion, merge `master` back into `dev` before continuing development so the next release meets strict branch freshness checks. Do not force-push or bypass production protection.

Public GitHub repositories also need an Actions event policy that allows `pull_request_target` specifically for `.github/workflows/promotion.yml`. Target that exact path and retain required branch checks. The promotion job only reads trusted base workflow metadata: it does not check out or execute PR code or access secrets. See [GitHub event protections](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

See [community chat](en/COMMUNITY.md) for channel access, media retention and realtime connections, and [state semantics](en/STATE-SEMANTICS.md) for the difference between program duration, registration timers and device state.

## Request reliability

New mutations must preserve authorization, target scope, idempotency and audit coverage. `server/request-safety.js` handles error events and optional idempotent replies; `server/audit-middleware.js` records business requests; `server/permissions.js` enforces individual grants. Register audit before safety and authorization so it sees the final status and matching event ID. Never log bodies, photos or credentials.

Cover simultaneous writes, conflicting idempotency bodies, changed identities/grants, stale profile responses and scoped results. Locks coordinate a runtime and store object; eventually consistent Edge KV does not provide cross-node transactions. High-concurrency deployment requires a single writer or transactional storage. Disabling a browser button is insufficient.

OAuth callback HEAD and explicitly marked prefetch requests must never exchange a code. Keep short-lived callback results for repeated requests. Expired or failed attempts require fresh authorization; do not automatically retry a one-use code. Show the event ID and status on failure. Log only fixed categories, upstream status and restricted provider request IDs, never codes, tokens or provider error bodies.

Automatic 3D quality starts clear without browser-name or memory-based downgrades. Allow an eight-second warmup after loading or resuming, then inspect dynamic frames in two-second windows. Three consecutive windows with frequent missed deadlines lower quality by one tier and show a three-second notice. Exclude static caps, background activity and loading. Changes have a 30-second cooldown, recovery requires sustained headroom, and manual quality remains fixed.
