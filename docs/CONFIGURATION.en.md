# Configuration

[Home](../README.en.md) · [中文](CONFIGURATION.md)

## Required values

Copy `.env.example` to a local `.env`, or set server-side environment variables on the cloud platform. Before using login or administration, set separate random `AUTH_SECRET` (at least 16 characters) and `ADMIN_TOKEN` (at least 8 characters). Missing secrets reject protected requests rather than falling back to a default password. The public mock dashboard can run independently.

Keep credentials on the server. `VITE_*` values are included in browser builds and must not contain secrets. Rotating `AUTH_SECRET` invalidates existing login tokens, admin tickets and derived sync keys.

| Setting | Purpose |
| --- | --- |
| `AUTH_SECRET` / `ADMIN_TOKEN` | Login signing and bootstrap super-admin access |
| `BUILDING_ID` / `BUILDING_NAME` | Board storage partition and name, separate from a user's dorm preference |
| `HAIER_MODE` | `mock` by default; `real` for live data |
| `HAIER_URL` / `HAIER_POSITION_ID` | Upstream endpoint and machine location, paginated by floor and category |
| `HAIER_HEADERS` / `HAIER_ACCOUNTS` | Optional server-side request headers or account pool |
| `HAIER_PAYLOAD` / `HAIER_PAGE_SIZE` | Legacy single-endpoint payload and page size; location mode takes precedence |
| `HAIER_STATE_MAP` | Currently defaults to `1` idle, `2` running and `3` faulty |
| `HAIER_TIMEOUT_MS` | Per-request upstream timeout, 8000 ms by default |
| `SYNC_STALE_MS` / `SYNC_WAIT_MS` | Lazy refresh threshold and initial wait without a snapshot |
| `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` | Internal DingTalk application for login and personal messages |
| `DINGTALK_ROBOT_CODE` / `DINGTALK_AGENT_ID` | Robot and application identifiers |
| `DINGTALK_AES_KEY` / `DINGTALK_TOKEN` | Callback decryption and signature verification |
| `DINGTALK_WEBHOOK` / `DINGTALK_WEBHOOK_SECRET` | Optional group channel and signing secret |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_JWK` / `VAPID_SUBJECT` | Browser push keys and contact information |
| `ASSISTANT_ENABLED` / `ASSISTANT_ENDPOINT` / `ASSISTANT_MODEL` / `ASSISTANT_API_KEY` | Optional AI defaults, also configurable in administration |
| `VITE_API_BASE` | Frontend API base; leave empty for same-origin production |
| `PORT` / `DATA_DIR` | Optional Node port and persistent data directory |

## Site and school

Use the deployment password at `/#/admin` to configure the site name, HTTPS or local icon, public school label and up to 30 dorms. Dorm codes must be unique and stable; changing or deleting a code requires affected users to choose again. Display names can change independently.

The school label may be public. The school ID is admin-only and is injected into the legacy `HAIER_PAYLOAD.schoolId`. The recommended multi-location flow still requires a separate `HAIER_POSITION_ID`; these IDs are not interchangeable.

The bootstrap super-admin may assign the following roles to users who have completed real DingTalk login. Account super-admins and the deployment-password entry can manage members and credentials. Admins may add, update or remove volunteers only; they cannot change higher-privilege members. The bootstrap entry cannot be deleted, and the last account super-admin cannot remove or downgrade itself.

| Role | Permissions |
| --- | --- |
| Super-admin `super` | Full administration, including members, credentials, AI configuration, moderation and inspections in all dorms |
| Admin `admin` | Site settings, volunteer assignments, moderation and inspections in all dorms; no highest-level configuration changes |
| Operator `operator` | Read-only administration; no automatic inspection or moderation access |
| Volunteer `volunteer` | Inspections in assigned dorms only; no moderation powers |
| User `user` | Everyday boards, tasks, queues and community features |

Volunteers need at least one currently valid dorm assignment. Roles come from the server's member table; disabled or blocked accounts lose elevated access, and changed permissions immediately constrain existing login tokens. `public` is reserved for the public message channel and cannot be a dorm code.

Site settings, roles and DingTalk overrides use persistent storage. Credentials are never returned by admin responses; only configured flags are exposed. Blank inputs retain values, while explicit clearing disables them. Initial environment values can bootstrap a deployment.

## Data and status

For real mode, configure the upstream endpoint, location and required headers, then verify them using admin diagnostics. The server combines sync requests and limits concurrency. A failed floor or category preserves the previous complete snapshot. Verified slot mappings determine machine type; identifiers alone do not establish dorm ownership.

Fault confirmation requires two different fresh snapshots at least 30 seconds apart; recovery also requires two. Unknown or stale data does not advance confirmation. Suspected uncollected laundry is derived only after a task has ended for at least five minutes without pickup confirmation; it is separate from a fault. Without an upstream finish time, estimates use 30 minutes for washers and 60 for dryers, superseded by real values when available.

## Task records

When registering laundry, users may add a note of up to 200 characters and record disinfectant use and self-cleaning. Both flags default to `false`. **The current active occupancy's note and both flags are shown on the public machine panel.** Pickup or clearing the occupancy removes that public display; the owner's task history retains the record. These are user reports, not proof of disinfection or self-cleaning, and do not control the machine, dispense disinfectant or change the wash cycle.

## Channels and inspections

The message directory shows the public channel, the user's dorm and other dorm channels. All are public discussion areas; dorm channels do not provide private-group access controls. The public channel does not link machines; machine discussions and queues belong in the corresponding dorm channel. Messages show the author's dorm and role badge. Super-admins and admins may delete messages, manage mutes and pin volunteer messages, with up to five pins per channel.

Authorized inspectors select a machine and submit a normal or issue report, a 1–500 character on-site note and a photo. The server checks the machine's actual dorm and rechecks permissions before saving rather than trusting client scope. The server accepts static PNG, JPEG, WebP and GIF up to 500KB, 4096 pixels per side and four million pixels total. The frontend compresses and re-encodes images; the server checks file structure and dimensions, with a 700KB total request limit. History is limited to 200 entries; entries older than 30 days are inaccessible and discarded photos are cleaned in batches. Inspection photos and notes are restricted to volunteers currently assigned to that dorm, super-admins and admins.

Super-admins and admins configure a DingTalk group conversation ID for each dorm, not a webhook or another URL. Delivery uses configured server-side DingTalk credentials. Only issue reports notify that dorm's group, with attempts for the same machine at least ten minutes apart. Confirmation waits at most twelve seconds; failure or timeout is recorded as unconfirmed, and a timed-out channel may still deliver. Slow delivery does not block history or photo reads. Normal inspections do not notify groups. Human reports do not directly change device fault status, and group notices do not include private photos or note text.

## Reminders and announcements

Configure the internal DingTalk app, login callback and robot callback over HTTPS. Admin diagnostics show delivery outcomes. Group summaries default to 08:00–22:00 Beijing time, evaluated within ten minutes after the hour, with at most one successful summary per hour. Unchanged states and countdown-only changes are skipped.

Favorite reminders require personal notifications, favorite machines in the user's dorm and weekday/time windows. Successful reminders are at least 30 minutes apart, up to three per occurrence; registering a task stops that occurrence. Queue reminders target only the head of the same machine, near three minutes before completion and at the end stage. Unknown completion times must not immediately imply availability. Sparse sync scheduling may miss the advance window.

Markdown announcements support titles, previews, dorm targeting, active times and version-based acknowledgment. Content is sanitized. Users can disable announcements in Settings.

Generate browser push keys with:

```bash
node tools/gen-vapid.mjs
```

Keep VAPID keys stable and let users explicitly authorize subscriptions. Web Push needs HTTPS or localhost and varies by browser. On iOS it generally requires adding the site to the home screen through Safari. WeChat and QQ embedded browsers generally do not support it; WeChat login and messaging are not implemented.

## Optional AI

Enable a Responses-compatible service with a model and server-side key. Without configuration no model is called, and core features remain available. Calls have rate, daily quota, output and timeout limits. Restricted tools read only the current user's dorm data; they do not send messages or execute pickup requests.

Users may disable or delete memory. Skills are inspectable prompt templates imported with confirmation, not executable scripts. The authenticated, rate-limited `/api/mcp` provides read-only machine tools. Third-party model processing follows the selected provider's policies.

## Individual permissions and tracing

Super administrators can select an existing member under Function permissions and scope, then restrict viewing, actions and dorm scope per feature. Action scope must be a subset of view scope. Roles set capability ceilings; grant the appropriate role before enabling administrative capabilities. An empty scope grants no dorms; All means unrestricted dorms. Site, system, model and global operations settings have feature switches without dorm scopes. Super accounts and the deployment-password recovery entry retain management access. Only members with effective administration viewing rights see the settings entry.

API failures show an HTTP status and event ID, searchable in operation logs. A `client_` ID with status 0 identifies a browser failure without a server response. Logs exclude request bodies, credentials, photos and chats. Writes use request deduplication; refresh to confirm an uncertain result before retrying.
