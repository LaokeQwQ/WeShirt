# Channel chat and deployment contract

[简体中文](../COMMUNITY.md) · [Deployment](../DEPLOYMENT.en.md) · [Machine state semantics](STATE-SEMANTICS.md)

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

Chat supports long-press replies, selecting channel members for mentions, images and short videos. Compressed images are limited to **500 KiB**. Videos are limited to **4 MiB (4 × 1024 × 1024 bytes)** and **30 seconds**, with an MP4/MOV container and H.264 video. File extensions, client MIME declarations and client-reported duration do not replace server-side content validation. Channel avatars are compressed to 256 pixels and have a server limit of 64 KiB.

Attachments are split into KV-sized chunks. Retention is 30 minutes for unsent uploads and 30 days for linked attachments. A global index supports bounded cleanup during sync: at most 20 expired attachments per pass, including metadata, chunks and owner indexes. Reading an expired attachment also cleans it up. Each user can keep at most 20 valid attachments; reaching the cap rejects new uploads rather than deleting valid, referenced media. Maintainers may adjust retention, but hiding expired metadata must not leave chunks stored forever. Reads still enforce current channel access, so a media URL cannot bypass dorm restrictions.

Mentions create orange in-app notifications that link to the source channel and can be marked read. Users with a valid DingTalk binding and notifications enabled can also receive a private message. Delivery uses deduplication and bounded retries with backoff, rechecking account status, message existence, enabled dorms and channel access before sending. This feature sends no group broadcasts or group mentions. In-app unread state and private-message delivery are separate states.

## Realtime transport

The browser has a real WebSocket connection. Internally, the relay polls a lightweight revision and personal unread count every **4 seconds**; it is **not database change streaming**. Only changes trigger invalidation events, and message content still comes from authenticated HTTP APIs. Initial readiness and reconnection also refresh data to recover changes missed while disconnected.

Hidden pages disconnect. Visible pages revalidate access, obtain a ticket and reconnect with backoff. HTTP refresh remains available when the relay is disabled or unavailable. Tickets travel in the first frame, never the URL. The backend rechecks access and limits short-lived connection leases; clients cannot publish messages through WS.

Deploy the relay as a separate CloudBase Web Function, leaving scheduled sync functions intact. See the [WebSocket relay deployment guide (Chinese)](../WEBSOCKET-RELAY.md) for builds, configuration, origin allowlists, limits and rollback. Connections consume function execution time and concurrency; monitor actual usage rather than describing this transport as polling-free or cost-free.
