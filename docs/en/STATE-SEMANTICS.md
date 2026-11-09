# Machine state and registration timers

[简体中文](../STATE-SEMANTICS.md) · [Channel chat](COMMUNITY.md)

## Machine kinds and programs

Upstream category codes take precedence: `00`/`01` identify washers and `02` identifies dryers. Without a trusted category, compatibility falls back to slot mappings, an existing kind and then the name. An alias or legacy slot cannot override an explicit upstream category, and clients cannot choose the machine kind.

Washer/self-clean registrations accept integer durations of **1–180 minutes**; dryers accept **10–180 minutes**. Presets are shortcuts, not a universal hardware program list. Only explicitly selecting the six-minute drum-clean preset records `program: self_clean`. Entering six minutes manually, or observing six minutes remaining, does not infer a program or mark the machine as already cleaned.

## Distinct sources

| Source | Meaning |
| --- | --- |
| Upstream state and real `finishAt` | Device-reported operation and expected completion time; an unknown program remains unspecified |
| User registration duration | A user-supplied estimate for registration and reminders, not hardware telemetry |
| Health projection | Fault/recovery confirmation from fresh, independent snapshots, including pending and stale states |

An operating machine without a real completion time shows an unknown duration. The application does not invent 30/60-minute completion times or mark it idle when a guessed timer expires. A registration timer reaching zero only means the user's estimated period has ended; completion still requires fresh device information or an on-site check.

When a user registers a machine that upstream temporarily still reports idle, the UI may show “registered by a user, awaiting device status” with an estimated source. This does not assert that the hardware started, and cannot override trusted running/fault or stale states. The old projection is removed when its valid registration ends or pickup is recorded.

Both fault and recovery confirmation require **two different fresh snapshots at least 30 seconds apart**. Re-reading the same snapshot does not count. A single fault sample remains pending; after a confirmed fault, one healthy sample remains pending recovery. Stale data becomes unknown. Refreshing the page or submitting a recovery report does not by itself prove the machine is healthy.

User registration and fault/recovery reports show a confirmation summary of the machine, timing mode, duration and public notes/flags before writing. Cancellation preserves drafts; changed targets or content require confirmation again. Contributions should preserve source distinctions and regression coverage for missing completion times, six-minute programs, delayed upstream updates and duplicate snapshots.
