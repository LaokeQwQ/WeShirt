# Data, privacy and usage

[Home](../README.en.md) · [中文](PRIVACY.md)

## Data scope

Dorm preferences, tasks, notification choices and collaboration relationships support their corresponding features. Public boards, messages and invitation previews expose necessary display fields without login credentials or phone numbers. Admin access follows operational permissions. School IDs and channel secrets stay in administration; secrets are not returned.

The public message channel and every dorm channel are public discussion areas. Messages may show the author's dorm and role badge; a dorm channel is not a private group. **The active occupancy's laundry note, disinfectant-use flag and self-cleaning flag are displayed publicly on the machine panel.** These are user-entered records: do not include phone numbers, credentials or other information you do not want to publish. Pickup or clearing the occupancy removes them from the public occupancy API, while the owner's task history remains available.

Inspection data is separate from those public task records. Inspection photos and on-site notes are available only to volunteers currently assigned to that dorm, super-admins and admins; revocation blocks further access. The frontend compresses and re-encodes images, but inspect the photo for unrelated people or personal information before submitting. Server-side format and size checks do not review image content. Inspection history is limited to 200 records and 30 days. Expired entries cannot be read; associated photos are deleted in bounded batches on later reads or submissions. Issue notifications send machine details and an issue notice, without inspection photos or note text.

CloudBase runs only the sync trigger. EdgeOne APIs store application data in bound persistent KV. Optional Node deployments use `DATA_DIR`. The operator manages access, backups and data lifecycle.

## Telemetry

Application telemetry accepts fixed events, route categories, dorm codes and bounded numbers. It aggregates by day and retains at most 14 days. It does not store user IDs, IP addresses, full URL queries, message bodies, error stacks or credentials. Infrastructure access logs are separately managed by the deployment operator.

Error records may include a random event ID, status and an allowed error category to correlate page feedback with recent admin errors. Browser exceptions without an HTTP response use status `0`; the same exception object is deduplicated. Console output contains only these safe fields, without exception messages or stacks. Disabling telemetry or enabling Do Not Track prevents client uploads.

Telemetry respects browser Do Not Track and can be disabled in Settings. API latency, Web Vitals and 3D performance are sampled metrics and cannot establish precise active-user counts.

## User controls and third parties

Notifications require configured channels and user permission. Users can manage personal notifications, announcements and push preferences. Browser permissions are controlled by the browser or operating system. AI is optional and memory can be disabled or deleted. Third-party model processing follows the selected provider's own policies.

Roles come from the server's member table. Volunteers inspect assigned dorms only; public-message moderation belongs to super-admins and admins. Admins cannot elevate higher-privilege members. Disablement or revocation immediately restricts existing sessions. Authorized admins manage dorm group conversation IDs and delivery outcomes; those values are not returned as public message data.

DingTalk login and messages, browser push and machine status depend on external services. Do not put admin credentials, push private keys or third-party secrets into browser build variables.

## Functional limits

This is an independent third-party query and reminder tool, unaffiliated with the machine platform, manufacturer or school. It reads equipment status and does not start, lock or pay for machines. Task registration and queues are coordination records, not a replacement for an official reservation system or checking on site.

Status depends on the upstream service and sync cycle. Estimated times are labeled. Suspected uncollected laundry is separate from a fault; fault and recovery require confirmation. Cloud hosting reduces server maintenance and single-machine risk, while platform, network and upstream interruptions may still cause delays or unavailability.

## Public source and logs

Exclude `.env`, live data, account pools, DingTalk credentials, VAPID private keys, AI keys, personal screenshots and deployment caches. Inspect files and history before publication. Rotate exposed credentials; deleting a file does not invalidate its old contents.

The sync trigger returns a fixed result category, status and event ID, and logs only these three fields on failure. It does not print URL secrets, request bodies or response bodies. Share sanitized timestamps, event IDs, categories and status codes when troubleshooting. See the repository license and acknowledgment section for project and third-party licensing.

## Operation records

Business writes, sensitive admin reads and exports record the necessary actor, route template, entity ID, status, result and event ID. They exclude bodies, query parameters, credentials, photos and chats. Routine board polling is not individually audited, and telemetry stays anonymous. Daily logs retain up to 500 events with bounded cleanup after 30 days. Authorized managers can search them; exports also audit. Restricting a member's board access does not make public machine information private.
