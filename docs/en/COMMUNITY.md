# Channel chat and deployment contract

[简体中文](../COMMUNITY.md) · [Deployment](../DEPLOYMENT.en.md) · [Machine state semantics](STATE-SEMANTICS.md)

## Directory summaries and read receipts

`GET /api/messages/channels` adds `summary` and `unreadCount` to each authorized channel. A summary is `null` or `{ messageId, nick, text, kind, at }`. Names are masked (for example, `李**同学`), text previews are limited to 80 characters, and media previews contain only `[图片]` or `[视频]`. `kind` is `text`, `image`, `video`, or `announcement`. The latest inserted, nondeleted message wins regardless of pin order. Disabled and unauthorized channels are omitted. Own messages do not count as unread; guest counts are zero.

Directory and message GET requests never acknowledge reading. After messages are actually displayed in a foreground channel, call `POST /api/messages/read` with `{ channel, messageIds: [...] }` (1–50 existing message IDs). Only those IDs and their matching mention notices become read. Older unseen messages and later arrivals remain unread. The response is `{ ok: true, channel, unreadCount }`. The compatibility field `throughMessageId` acknowledges one ID only, never a range, and cannot be combined with `messageIds`.

Receipts merge through durable compare-and-set so independent devices cannot overwrite each other. No client timestamp is accepted. Missing or deleted IDs return 404; refresh before retrying. Current view access is required, so muted and read-only members can acknowledge visible messages. Unavailable receipt storage returns a traceable 503. Request snapshots avoid repeated collection, profile, and role lookups without caching permissions across requests.

## Channels and roles

| Role | Accessible channels | Channel management |
| --- | --- | --- |
| Guest | Public channel, read only | None |
| Signed-in user | Public and their currently bound dorm | Own messages; no access to other dorm channels |
| Dorm volunteer (`volunteer`) | Public and their own dorm | Announcements, pinning, channel avatar and `@all` in authorized public/own-dorm channels |
| Administrator (`admin`) / super administrator (`super`) | Cross-dorm access within server-authorized view/operation scopes | Manage authorized channels; administrative access still depends on role and grants |

Opening a channel does not change the user's bound dorm. Public chat cannot reference a machine. Avatars, current author dorms and role badges identify authors; the backend determines identity. Pinned messages appear first. Announcements and channel-avatar changes require the same channel authorization.

The initial dorm binding is free and does not consume the one permitted self-service change. Further changes require an authorized administrator. Saving the same dorm consumes no change. Disabling a dorm preserves bindings, messages, tasks and audit history while stopping new operations and reminders for that dorm. Re-enabling it retains its identity; do not delete and recreate it as a different dorm.

## Chat and notifications

Hold an avatar to mention its author; hold a message to open Reply and Report. The plus menu also provides member selection and authorized all-member mentions. Scrolling and canceled touches cancel the hold, and menus support keyboard access. Compressed images are limited to **500 KiB**. Videos are limited to **4 MiB (4 × 1024 × 1024 bytes)** and **30 seconds**, with an MP4/MOV container and H.264 video. File extensions, client MIME declarations and client-reported duration do not replace server-side content validation. Channel avatars are compressed to 256 pixels and have a server limit of 64 KiB.

Reports require current channel access and an existing message. Repeated reports by the same author for one message reuse a receipt; limits are 3 per minute and 10 per day. Administrators need message-management permissions for the relevant building. Reports retain a bounded text snapshot, reason and attachment type, and survive message deletion. Reporter identity is omitted from management listings. The queue holds up to 500 reports, retains closed records for 90 days, and audits handling actions.

Hourly group summaries default to 08:00–22:00 Asia/Shanghai. Each building has independent change detection and retry state; unchanged status does not send another summary. Markdown sections list idle, running and confirmed-fault machines without inventing missing finish times. Building notification settings select the destination for summaries and abnormal inspections; an explicitly empty setting disables it. The original custom webhook remains scoped to the original Guiyuan laundry room. Unclassified machines and unrelated buildings never enter its summary, and an unrecognized observed group cannot subscribe to the entire campus.

Attachments are split into KV-sized chunks. Retention is 30 minutes for unsent uploads and 30 days for linked attachments. A global index supports bounded cleanup during sync: at most 20 expired attachments per pass, including metadata, chunks and owner indexes. Reading an expired attachment also cleans it up. Each user can keep at most 20 valid attachments; reaching the cap rejects new uploads rather than deleting valid, referenced media. Maintainers may adjust retention, but hiding expired metadata must not leave chunks stored forever. Reads still enforce current channel access, so a media URL cannot bypass dorm restrictions.

Mentions create orange in-app notifications that link to the source channel and can be marked read. Users with a valid DingTalk binding and notifications enabled can also receive a private message. Delivery uses deduplication and bounded retries with backoff, rechecking account status, message existence, enabled dorms and channel access before sending. This feature sends no group broadcasts or group mentions. In-app unread state and private-message delivery are separate states.

## Realtime transport

The browser has a real WebSocket connection. Internally, the relay polls a lightweight revision and personal unread count every **4 seconds**; it is **not database change streaming**. Only changes trigger invalidation events, and message content still comes from authenticated HTTP APIs. Initial readiness and reconnection also refresh data to recover changes missed while disconnected.

Hidden pages disconnect. Visible pages revalidate access, obtain a ticket and reconnect with backoff. HTTP refresh remains available when the relay is disabled or unavailable. Tickets travel in the first frame, never the URL. The backend rechecks access and limits short-lived connection leases; clients cannot publish messages through WS.

Deploy the relay as a separate CloudBase Web Function, leaving scheduled sync functions intact. See the [WebSocket relay deployment guide (Chinese)](../WEBSOCKET-RELAY.md) for builds, configuration, origin allowlists, limits and rollback. Connections consume function execution time and concurrency; monitor actual usage rather than describing this transport as polling-free or cost-free.
