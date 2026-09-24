# DearByte Implementation Plan

**Project name:** DearByte. Local folder: `dearbyte`.

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only if the user selects that execution method. Track progress with the checkboxes below.

**Goal:** Build a personal Chinese-speaking AI companion that runs from a terminal, receives text and photos through WeChat, and returns natural, short replies informed by 狗头军师, conversation history, and persistent memory.

**Architecture:** A local TypeScript process owns conversation assembly, models, memory, and a durable outgoing queue. A narrowly scoped macOS desktop adapter observes the manually selected WeChat chat on a test account and, only in an explicitly enabled mode, submits replies through that window. Prefer macOS Accessibility metadata; evaluate cropped screenshots/OCR only when necessary. No OpenClaw, Tencent iLink client, account-token extraction, or process hooking is part of the selected implementation.

**Tech stack:** Proposed: TypeScript, a supported Node.js LTS release, SQLite through `better-sqlite3`, Zod, Pino, Commander, and Vitest, plus a small Swift macOS Accessibility helper if the read-only probe supports it. Use a provider adapter for a vision-capable language model. Start with readable terminal logs; do not build a web interface or full-screen terminal framework for the first release. Verify package compatibility and pin exact versions during setup.

**Spec:** The design brief and acceptance criteria in this document capture the conversation and supplied video. This is a draft implementation plan, not a claim that a WeChat connector has been verified or selected.

**Status:** Planning only. The workspace was empty apart from `.git` when this plan was written. No product dependencies, external accounts, or connectors have been installed.

## 1. Design brief

The user wants a hobby project suitable for filming for Douyin around **“原来人真的会爱上代码”**. The companion should have a **嘴贫但细心** personality and become familiar through accurate continuity and shared conversation. 狗头军师 is the source of useful Chinese relationship and communication guidance; adapt its material rather than treating it as a ready-made companion or trained model.

The reference video shows a phone displaying a WeChat conversation in front of a computer terminal. A person sends a cat photo with “刚刚回来路上看见的，你看看这是什么”. The replies identify the cat, comment on it, then make a personal conversational connection. Terminal output appears to track message processing and sending. The video establishes the desired visible experience, not its transport implementation, platform authorization, model location, or memory reliability.

### First successful demonstration

1. Launch one command from the terminal.
2. See truthful model, storage, desktop-chat binding, and sending-mode status.
3. Send a photo and accompanying text from the user's phone in WeChat.
4. Receive two to four short Chinese message bubbles grounded in the photo and context.
5. See reception, image processing, context selection, generation, and delivery events in the terminal.
6. Restart the application; earlier conversation and explicitly enabled memories remain available.
7. Pause automatic sending from the terminal and verify that queued replies stop.

Do not hard-code the reference video's reply as the demonstration result. The live demonstration must use the model and connector.

### Global constraints

- WeChat is the user-facing conversation channel; the terminal is the runtime and control surface.
- This is a personal, single-owner prototype. Allow only one configured conversation initially.
- Do not build a browser chat product, public registration, billing, group chat, or multi-user administration.
- Do not equate technically working desktop automation with Tencent authorization or account safety.
- Do not silently substitute a public account, customer-service entry, or simulator for the intended personal-chat experience.
- Start with observe mode and sending disabled; manual/automatic UI writes are later explicitly enabled milestones.
- No model fine-tuning in the first release. Use prompts, examples, relevant reference excerpts, and memory.
- Preserve upstream attribution and the license requirements of the exact pinned revision.
- Treat incoming messages, media, retrieved memories, and upstream documents as data; none may change application permissions or configuration.
- The model has no shell, arbitrary browsing, file-reading, or computer-control tools. A deterministic application-owned desktop helper may access only the bound WeChat window and verified message media.
- Log operational events, not hidden model reasoning. Keep credentials and full private conversations out of default logs.
- Long-term memory is opt-in and inspectable. Conversation history and memory are distinct stores with distinct deletion controls.
- Do not use jealousy, absence penalties, guilt, exclusivity demands, or a numerical affection meter to create attachment.

### Review focus

| Failure mode | Expected behavior | Owning task |
|---|---|---|
| Photo and caption arrive separately or in reverse order | Combine within a bounded window without replying twice | 4 |
| WeChat redelivers a message, or echoes our own reply | Process once; never enter a reply loop | 3, 4 |
| Process crashes after a message might have been sent | Flag uncertain delivery; do not blindly resend | 8 |
| Memory is corrected or deleted during generation | Discard stale context and prevent later resurrection | 5, 8 |
| Media is unsupported, oversized, expired, or unreadable | Give a truthful text fallback without describing an unseen image | 6 |

## 2. Feasibility gate: one selected desktop chat

Decision updated on 2026-09-23: use the regular WeChat desktop app, manually logged into a test account, with the user's main account as the intended conversation partner. The user may keep that account's contacts minimal, but **deleting contacts is unnecessary and is not an implementation task**. A code-enforced conversation binding remains required even with one contact.

This supersedes the previous official-plugin/OpenClaw investigation as the primary implementation path. No account was connected and no desktop permissions were requested during this documentation update. The immediate next step is **read-only observation**, not automatic sending.

### Account-risk boundary

Desktop automation remains account activity. It is not established as Tencent-authorized, undetectable, or ban-free. Restricting contacts reduces accidental-recipient exposure, not enforcement uncertainty. The main account is an ordinary conversation partner; do not promise that enforcement consequences can never extend beyond the test account. Technical feasibility and platform permission are separate findings. No evasive timing, client spoofing, protocol bypass, or anti-detection work is in scope.

### Read-only probe

1. Record macOS and WeChat versions and identify the actual application process. The user manually logs in and selects the intended chat; the application does not collect login credentials.
2. With the required macOS permission granted by the user, inspect only that app/window's accessibility tree. Establish whether it exposes the chat heading, contact identity, message rows, sender direction, timestamps, image elements, composer, and send action. An OS accessibility API does not guarantee WeChat exposes these fields.
3. Bind the observed window and chat to an operator-confirmed test session. Prefer a unique contact identifier if the UI exposes one. A nickname/avatar/title alone is not a guaranteed stable identity; if the evidence cannot distinguish the chat reliably, allow observation/drafts but do not enable unattended sending.
4. Baseline existing rows without replying to old history. Ask the user to send new test messages, including two identical messages, a multiline message, a photo, and photo-plus-caption in both orders. Do not type, paste, click Send, change chats, or trigger model calls during this probe.
5. Check scrolling, incoming/outgoing differentiation, system notices, window movement, focus loss, app restart, and account switch. Document uncertainty rather than invent remote message IDs or delivery receipts.
6. If accessibility lacks necessary content, evaluate an explicitly selected chat-region screenshot and local OCR. Request screen-recording permission only when this fallback is needed. Do not capture the whole desktop or send screen images to an external model by default.
7. Record results in `docs/design/wechat-desktop-feasibility.md`, including redacted structural fixtures, media limitations, and whether the result supports observe-only, drafts, manual-send, or guarded automatic mode.

### Progressive operating modes

| Mode | Reads selected chat | Calls model | Writes to WeChat |
|---|---|---|---|
| `observe` (default) | Yes | No | Never |
| `draft` | Yes | Yes | Never; shows proposal in terminal |
| `manual` | Yes | Yes | Only after approval of that reply in the terminal |
| `auto` | Yes | Yes | Only after explicit arming for this session and all guards pass |

Every launch starts with sending disabled. `/resume` cannot bypass mode selection, an unverified chat binding, or permission failures. Auto mode is a later acceptance milestone, not authorization supplied by the read-only probe. Lock, account change, window replacement, or conversation change disarms sending; operator rebind/re-arm is required.

### Desktop adapter design

Prefer a Swift helper using `AXUIElement` and accessibility notifications, with bounded polling when notifications are incomplete. TypeScript communicates with the helper over structured local stdio. Keep the helper API narrow: observe the bound chat, retrieve a verified attachment, and submit a validated text draft. Never expose general clicks, shell commands, or arbitrary UI navigation as model tools.

Add `native/wechat-accessibility/Package.swift`, `native/wechat-accessibility/Sources/WechatAccessibility/main.swift`, `src/channels/desktop/{client,identity,observations,send-guard}.ts`, and tests under `tests/desktop/`. Compile and pin helper behavior against the observed app version; OS permission changes must fail with a clear terminal status.

Immediately before writing, verify the app process, bound window and chat evidence, focus, lack of dialogs, and expected composer state. Do not overwrite a human's existing draft. Recheck after filling the composer and before Send. Abort when context changes. These checks reduce but cannot eliminate the race between checking the UI and a human changing it; do not promise atomic recipient enforcement. If we cannot target controls reliably, keep manual mode.

Use direct accessibility text actions when supported. Clipboard fallback must be explicitly enabled, must not inspect or log unrelated clipboard contents, and must not clobber a newer clipboard change during restoration. Coordinate-only clicks must not be the basis for unattended sending.

### Message identity, recovery, and media

UI rows may not have stable server IDs. Generate a local observation ID using session identity, direction, neighboring rows, timestamps when present, and content. Persist the observed sequence and reconcile overlapping snapshots; a text hash alone would incorrectly merge two genuine identical messages. Virtualized rows, scrolling, OCR changes, and uncertain gaps must pause automatic ingestion or request reconciliation. Do not claim exactly-once delivery or complete history capture.

On restart, baseline visible history and reconcile pending sends before resuming. A new outgoing bubble is only a local observation, not proof of server delivery or receipt. A timeout after clicking Send is `unknown`; never retry it blindly. Do not automatically replay old visible messages or unsent drafts after restarting.

Photos require their own feasibility check. Prefer a UI-supported save/copy action for the selected message during a separately enabled media phase. A thumbnail or OCR transcript is not the original image. If only a crop is available, label that limitation and ask for a clearer image when needed. Bound capture to the selected chat/image; do not inspect the account's database or sweep attachment directories. Fail truthfully when media cannot be obtained.

OS Accessibility and screen capture permissions can be broader than our intended scope. Limit reads in code, keep local screenshots transient, and expose no desktop tools to the model. Existing WeChat app caches are managed by WeChat and are not deleted by our memory command; document that distinction.

### Image processing and observed evidence — 2026-09-24

**Observed:** User-supplied Accessibility output exposes incoming/outgoing text, separate rows for repeated identical messages, the selected chat title, and photo-event labels (`Sent aPhoto`). It does not expose photo bytes or a file path. Element indexes change, and timestamp labels can change at midnight. The two-line sample was two separate bubbles: single-bubble multiline handling remains unverified. These observations do not establish stable account identity or reliable sending.

**Retrieval priority:**

1. Inspect photo-element actions without invoking them. In a separately enabled media test, manually verify WeChat's normal Save Image or Copy Image behavior for the selected message. Saved/copied images may be compressed; do not claim original quality without evidence.
2. If necessary, open that photo and capture only its displayed image region, with the required screen-recording permission. Label the result as a rendered capture with resolution limits.
3. Use a thumbnail crop only as a last resort, labeled low-detail. A photo label or OCR transcript is never sufficient to describe the picture.

Observe mode remains read-only, without image-opening actions, clipboard changes, screenshots, or model calls. Enable media retrieval separately from sending. Keep chat/window checks active and stop on ambiguity or dialogs. Do not read databases or sweep attachment folders. Clipboard fallback must not expose existing content or overwrite a newer user clipboard change during restoration.

```text
Photo occurrence + nearby caption
  → match the exact local message occurrence
  → bounded turn assembly
  → retrieve image bytes or a labeled crop
  → validate format, byte size, pixel dimensions, and orientation
  → strip unnecessary metadata and resize for the provider
  → vision-capable model + caption + relevant context
  → validate short reply bubbles
  → delete temporary images
```

**Association:** Assign each observed photo occurrence its own attachment ID and source turn. Do not use a transient UI index, content hash, filename, or most-recent download as its identity. Preserve repeated identical photos and photo order. Retain the two-second quiet window/five-second maximum as grouping heuristics, not proof of caption ownership. Pass ambiguous photo groups together or ask for clarification. Late captions become later conversation context rather than attaching to the wrong photo. Give retrieval a proposed 15-second deadline after assembly and keep subsequent turns ordered.

**Implementation:** Add `src/channels/desktop/media.ts` for scoped UI retrieval and `src/media/attachments.ts` for association. Replace section 5's bare-byte `Channel.fetchImage` return with a typed result containing attachment ID, ready/unavailable status, MIME/bytes when available, source (`saved`, `clipboard`, `viewer-crop`, `thumbnail`), quality, and failure reason. Update simulator, desktop adapter, and all callers together. Fail truthfully on inaccessible media rather than guessing from its label.

**Providers:** Verify image support for the selected model and send actual image content in its documented multimodal format. A local filename is not an image upload. Text-only configurations must explicitly select a vision provider or report unsupported images. Never silently route photos to another provider. Pass quality limitations to the model. If a two-model image-description pipeline is introduced later, disclose both providers and preserve uncertainty.

**Privacy and memory:** Disclose which provider receives image content before enabling cloud processing. Capture only the verified image region, excluding unrelated messages, sidebar, and draft text. Apply existing size limits; normalize orientation before removing EXIF/location metadata. Keep raw images/base64 out of database history and logs. Delete temporary images after success, failure, or cancellation; startup cleanup handles abandoned files. WeChat's own caches and provider retention are separate from our application's deletion controls.

With memory enabled, store only useful sourced summaries such as “用户分享了一张路边猫咪的照片”. Separate user-stated facts from uncertain visual observations; do not infer ownership, identity, or precise location from appearance alone. Raw photo retention stays off. Deleting memories invalidates derived summaries and pending extraction jobs.

**Task additions:**

- [ ] Task 1: record confirmed photo-event detection; inspect actions without opening/saving images. Original-image retrieval remains unverified.
- [ ] Task 3: test the selected Save/Copy or capture path, changed chats, permission denial, dialogs, and clipboard interference.
- [ ] Tasks 3–4: add `tests/media-association.test.ts` covering rapid different photos, identical repeated photos, caption-first/photo-first, ambiguous groups, and late captions.
- [ ] Task 6: extend image tests for corrupt/unsupported files, decoded-size limits, rotated images, metadata stripping, blurry thumbnails, capability mismatch, and retrieval timeout.
- [ ] Tasks 6–8: verify temporary-file cleanup across success/failure/cancellation/restart, no raw image logging, and no silent provider fallback.
- [ ] Task 9: compare a non-private test image against actual model input; record retrieval quality, matching accuracy, latency, and truthful failure responses.

### Other approaches considered

| Method | Relationship to a running desktop client | Decision |
|---|---|---|
| macOS Accessibility / Windows UI Automation | Structured interaction with exposed controls; still UI automation | Preferred Mac probe; Windows projects require a separate platform decision |
| Cropped screenshot + OCR + input automation | Reads pixels when controls are inaccessible | Fallback; focus/layout/OCR errors require strict guards |
| Explicit copy/paste or file export | Human provides content; no automatic inbound channel | Useful manual fallback; preserves the companion workflow |
| Notification observation | Partial message previews, depending on OS/app settings | Insufficient as authoritative history, identity, or photo transport |
| Local history database/cache access | May expose historical data; does not supply sending by itself | Excluded; account data access is broader than our selected chat |
| Process hooks/injection | Calls or intercepts desktop-client internals, often version-specific | Excluded from this project; unnecessary intrusion and maintenance burden |
| Official iLink/OpenClaw plugin | Separate bot channel; does not attach to the current desktop chat | Historical alternative only; no installation in this plan |

Sources: [Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement), [Windows-only wxauto](https://github.com/cluic/wxauto), [WeChatFerry hook-based project](https://github.com/wechatferry/wechatferry), and [Tencent plugin](https://github.com/Tencent/openclaw-weixin). These establish mechanisms, not Tencent authorization of our desktop automation.

**Feasibility outcome:** record `observe-only`, `draft-capable`, `manual-send-capable`, or `guarded-auto-capable`, separately from `platform-permission-unverified`. If identity or message tracking is unreliable, do not upgrade the mode. The user must see those limitations before a live automatic-send test.

## 3. Runtime and data flow

```text
Main account on phone ↔ test account in desktop WeChat
    │
    ▼
Desktop adapter ── verify bound window/chat, observe rows, ignore outgoing/system events
    │
    ▼
Durable inbox ── deduplicate, combine nearby text + photo, serialize per chat
    │
    ▼
Context builder
    ├── recent turns and bounded summary
    ├── enabled, relevant memories with provenance
    ├── companion persona and dialogue examples
    └── selected 狗头军师 references
    │
    ▼
Vision-capable model adapter ── structured bubble output
    │
    ▼
Validated reply → durable outbox → channel adapter → WeChat

All stages → redacted runtime events → terminal
```

Run locally on the user's Mac with the manually opened test-account chat. A Windows implementation is a separate scope decision. Local orchestration does not mean local inference: disclose the configured model provider and which messages/images are sent to it before a live run.

## 4. Proposed repository structure

```text
src/
  cli.ts                       # commands and flags
  app.ts                       # lifecycle and dependency composition
  config.ts                    # typed, validated settings
  domain.ts                    # shared transport-independent types
  channels/
    channel.ts                 # channel contract and capabilities
    simulator.ts               # terminal and fixture input for development
    wechat.ts                  # selected desktop-chat adapter facade
  runtime/
    inbox.ts                   # persistence and inbound deduplication
    turns.ts                   # photo/text assembly and per-chat queue
    orchestrator.ts            # receive-to-reply coordination
    outbox.ts                  # ordered durable delivery
    events.ts                  # operational event definitions
    terminal.ts                # display and live control commands
  companion/
    context.ts                 # token budget and context selection
    guidance.ts                # approved-reference routing
    output.ts                  # reply schema and validation
  model/
    provider.ts                # generation contract
    remote.ts                  # concrete provider integration
    fake.ts                    # deterministic test double
  media/
    images.ts                  # format, size, decoding, orientation
  storage/
    database.ts                # SQLite setup and transactions
    migrations/001_initial.sql
    conversations.ts
    memories.ts
    summaries.ts
  memory/
    extract.ts                 # candidate extraction
    retrieve.ts                # bounded retrieval
    lifecycle.ts               # consent, correction, deletion
prompts/
  persona.zh-CN.md
  dialogue-examples.zh-CN.json
  response.schema.json
references/goutoujunshi/        # pinned upstream material and license
config/companion.example.json
tests/                         # unit, integration, fixtures, evaluation cases
docs/
  design/wechat-desktop-feasibility.md
  upstream-provenance.md
  runbook.md
  evaluations/companion-rubric.md
.env.example
.gitignore
package.json
package-lock.json
tsconfig.json
README.md
```

Ignore `.env`, `data/`, logs, temporary media, and real-chat recordings in Git. Never place credentials in example configuration.

## 5. Shared contracts

Define these in `src/domain.ts`, `src/channels/channel.ts`, and `src/model/provider.ts` before building dependent modules. IDs are strings; timestamps are UTC ISO strings. Per-chat ordering comes from the persisted inbox sequence, not assumptions about remote timestamps.

```ts
type IncomingMessage = {
  channel: "simulator" | "wechat";
  id: string;
  conversationId: string;
  senderId: string;
  sentBySelf: boolean;
  receivedAt: string;
  text?: string;
  attachments: Array<{
    id: string;
    kind: "image";
    mediaRef: string; // opaque to the core; resolved by the channel
  }>;
};

type Turn = {
  id: string;
  conversationId: string;
  messageIds: string[];
  text: string;
  imageIds: string[];
};

type Reply = { bubbles: string[] };
type Delivery =
  | { status: "sent"; remoteId?: string }
  | { status: "failed"; retryable: boolean; reason: string }
  | { status: "unknown"; reason: string };

interface Channel {
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  fetchImage(mediaRef: string): Promise<Uint8Array>;
  sendText(conversationId: string, text: string, key: string): Promise<Delivery>;
  stop(): Promise<void>;
}

type ModelInput = {
  instructions: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  images: Array<{ mimeType: string; bytes: Uint8Array }>;
};

interface ModelProvider {
  generate(input: ModelInput, signal: AbortSignal): Promise<Reply>;
}
```

Passing an idempotency key to `sendText` does not guarantee the remote transport honors it. The adapter must document its actual capabilities. If stable inbound IDs are unavailable, specify and test a bounded fingerprint strategy and its collision limitations before allowing live replies.

## 6. Companion behavior and upstream adaptation

### Preserve from 狗头军师

- Respond to what the person feels and actually says.
- Separate observable facts from guesses about other people's motives.
- Use relevant Chinese conversational and relationship context.
- Ask a small, useful follow-up when necessary.
- Maintain explicit memory consent and honest uncertainty.

### Replace in the companion layer

- Remove the initial relationship questionnaire and scoring.
- Remove routine strategy reports, action plans, and multi-option advice.
- Use short, conversational Chinese; allow humor and gentle disagreement.
- Respond to shared daily experiences instead of treating every message as a problem to solve.
- Let warmth follow the conversation. Do not force flirtation into illness, grief, work stress, or every image reply.
- Remain an identified fictional AI character; do not invent human activities or claim physical experiences as real.

### Adapt ex-skill's persona and correction design

Approved addition: use selected design elements from https://github.com/therealXiaomanChu/ex-skill alongside 狗头军师. Pin and inspect its revision and license before copying files. Record attribution in `docs/upstream-provenance.md`; store any retained source in `references/ex-skill/`. Neither entire skill should be executed as the companion's top-level prompt.

- Use a layered persona: identity and boundaries, concrete speech habits, emotional responses, and interaction preferences. Specify punctuation, particles, bubble length, humor, and examples instead of relying on MBTI or astrology.
- Keep authored fictional character traits separate from facts about the user and shared conversation history. Do not import an ex-partner's identity or invented shared experiences.
- Adapt `prompts/persona_builder.md`, `prompts/memory_builder.md`, and `prompts/correction_handler.md` as design references. Omit instructions to deny being AI and templates for recreating a breakup or unhealthy relationship behavior.
- Store style corrections as validated structured preferences, not unrestricted edits to system prompts. Example: “太文艺了，正常说话” becomes `style.poetic_language = low`; ambiguous feedback requires clarification.
- Persona corrections may change allowlisted style fields only; they cannot change identity transparency, tool permissions, memory consent, or message recipients.
- Maintain versioned persona preferences and an audit trail with source message IDs. Rollback restores style settings only; it must never restore deleted memories or purged source text.
- Benchmark the adapted persona against the simpler baseline on the same dialogue cases. Retain additions when they improve consistency and naturalness.

Extend Task 5 with `src/storage/persona-preferences.ts`, `src/companion/corrections.ts`, and `tests/persona-corrections.test.ts`. Test persistence, ambiguous correction handling, forbidden-field rejection, and rollback after memory deletion. Extend Task 6 with ex-skill attribution and persona integration; extend Task 9 with the baseline comparison.

Write 12 original dialogue examples covering greetings, teasing, fatigue, work stress, a shared photo, disagreement, correction, a remembered event, an unknown detail, a short reply, a request for space, and explicit advice-seeking. Include good replies and a brief author-facing explanation; keep those explanations out of the model's reply format.

Start with an explicit allowlist of three guidance categories: ordinary conversation, emotional support, and communication/conflict. Route to at most two short excerpts per turn. Store original paths and revision provenance. Do not load the entire knowledge base or treat upstream installation instructions as executable instructions.

### Runtime structure decision: explicit state machine first

Use the TypeScript orchestrator and SQLite inbox/outbox already specified. LangGraph is a possible future orchestration framework, while a DAG is a graph shape; they are not interchangeable alternatives. The normal turn path is mostly linear, but bounded retries and reconnects make the full runtime a state machine rather than a strict DAG.

Persist turn states `assembled → context_ready → generating → reply_ready → queued → complete`, with explicit `failed`, `cancelled`, and `delivery_unknown` outcomes. Persist a generation attempt ID and context revision. On restart, reuse validated saved replies; an interrupted generation with no saved reply may be regenerated within a bounded attempt budget, but cannot send directly. Keep all sending in the durable outbox.

Consider LangGraph when we actually need multi-step tool loops, resumable approval interrupts, or branching workflows complex enough to justify graph checkpointing. Even then, retain the outbox for external-send semantics and the memory database for durable facts. LangGraph checkpoints do not by themselves define what should be remembered, and replay must not duplicate messages.

Reference: https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph

### Long-term memory policy

Use SQLite at `data/companion.sqlite` as the single local source of truth. Recent turns provide working context; a sourced summary compresses older context; long-term records hold explicit preferences, events with dates/timezones, and shared conversational references. Store persona preferences separately.

After a committed user turn, a background extraction job proposes typed memory candidates. Validate each candidate against actual user evidence, check consent and the current context revision, then merge by normalized key. Do not let extraction delay the reply. Extraction retries are keyed by source turn and cannot duplicate records. Failed extraction is visible but does not fail message delivery.

Resolve relative dates against the message timestamp and configured user timezone. Preserve uncertainty rather than inventing dates. Supersede conflicting facts with a sourced correction; expire time-sensitive events from active retrieval after their relevance window. Start with explicit fact categories, normalized aliases, recency, and Chinese-aware text matching; do not assume default whitespace-based full-text search works for Chinese. Add Chinese retrieval fixtures for paraphrases and aliases. Add embeddings only if measured recall is inadequate.

Deletion must cover derived summaries, candidate jobs, cached contexts, and any future embedding index. Compact audit records may retain deletion IDs and timestamps, but not deleted values. If backups are introduced, define expiry and prevent restored backups from resurrecting purged records before enabling them.

### WeChat and MCP boundary

MCP standardizes access to tools and resources; it does not supply a WeChat account connection or grant platform authorization. The verified desktop adapter remains a prerequisite whether we call it directly or wrap it in MCP.

For the first release, target our `Channel` adapter over the bounded desktop helper. Incoming observations enter the durable inbox; there is no iLink account token or competing network poller. Outgoing replies pass through the outbox and desktop identity/focus guards. If later wrapped in MCP, expose only these scoped operations, not general desktop control.

If an MCP interface is later needed by another agent host, wrap the same service rather than implementing a second delivery path. Proposed narrow tools are `wechat.status`, `wechat.fetch_media` for an already-ingested attachment ID, and `wechat.enqueue_reply` for an existing allowlisted conversation and turn ID. Return a queue ID and expose delivery status separately; do not equate queuing with successful delivery. Enforce authentication, recipient scope, deduplication, pause state, and rate limits in the server, regardless of model instructions.

Use local stdio for a same-machine MCP wrapper if suitable for the selected SDK/protocol version; logs must go to stderr rather than corrupt protocol stdout. A remote bridge requires an authenticated network transport and a separate security/configuration decision. The exact transport and capabilities must be verified against the selected MCP SDK version before implementation. MCP is not an initial release dependency and does not resolve Task 1.

Reference: https://modelcontextprotocol.io/specification/2025-11-25/architecture

## 7. Defaults to implement and measure

These are proposed engineering defaults, not platform guarantees.

| Setting | Initial value |
|---|---|
| Allowed conversations | One explicit conversation ID |
| Maximum combined incoming text | 8,000 Unicode code points; reject excess with a short explanation |
| Turn assembly | 2-second quiet window, maximum 5 seconds from first message |
| Maximum images per turn | 3 |
| Maximum image size | 10 MiB each, with decoded-pixel limit of 20 megapixels |
| Accepted images | JPEG, PNG, WebP; verify actual decoding, not filename alone |
| Model context budget | 12,000 tokens including images, or less if provider limit requires |
| Reply | 1–4 nonempty bubbles, each at most 120 Unicode code points |
| Model request timeout | 30 seconds |
| Transient generation retry | At most one retry, with provider-specific retry-after handling |
| Bubble interval | Configurable 0.8–1.8 seconds, subject to actual connector limits |
| Recent conversation | Last 20 complete turns within the context budget |
| Retrieved memories | At most 8 relevant active records |
| Long-term memory | Off until explicitly enabled |
| Local history retention | 30 days by default; configurable and disclosed |
| Downloaded image retention | Delete after processing; startup cleanup for abandoned files older than 1 hour |
| Structured log retention | 7 days; no message bodies by default |

When the context is too large, remove lower-priority guidance and older history before truncating the latest user message. Use the provider's image token accounting. Record measured end-to-end latency; do not promise a fixed response time before live connector testing.

## 8. Storage and delivery model

Use SQLite transactions and WAL mode. Initial tables:

- `conversations`: allowed identity, memory consent, pause state, context revision.
- `inbox`: channel + local observation ID unique key (remote ID only if actually exposed), local sequence, conversation, payload, received time, processing state.
- `turns`: grouped inbox IDs, input, generation state, context revision used.
- `messages`: conversation, turn, role, content, timestamps, outbound receipt if available.
- `memories`: conversation, category, normalized key, value, source message ID, created/updated time, active/deleted state.
- `summaries`: conversation, bounded summary, covered sequence, context revision.
- `outbox`: turn, bubble index, content, delivery key, pending/sending/sent/failed/unknown state, attempts, receipt.
- `settings`: schema version and non-secret runtime preferences.

Uniqueness on `(turn_id, bubble_index)` prevents duplicate outbox creation. Persist `sending` before the network call. A crash with `sending` rows makes those rows `unknown` on restart unless the connector can reconcile receipts. Never claim exactly-once network delivery when the transport cannot provide it.

Memory deletion increments the conversation context revision, invalidates summaries, cancels pending extraction/generation, and removes affected unsent replies. Delete or redact supporting history so extraction cannot immediately recreate the fact. Explain separately that deleting local data does not delete already sent WeChat messages or provider-side records.

## 9. Implementation tasks

### Task 1 — Read-only desktop feasibility

**Files:** `docs/design/wechat-desktop-feasibility.md`, redacted fixtures in `tests/fixtures/desktop/`.

**Produces:** Evidence for the operating modes and message/media capabilities defined in section 2. Platform permission remains a separate unresolved question.

- [ ] Record actual OS/app versions and the manually selected test-account conversation. Do not delete contacts or collect account credentials.
- [ ] Inspect selected-window accessibility metadata after the user grants the necessary OS permission. Do not send messages or call the model.
- [ ] Establish contact identity evidence, sender direction, row ordering, repeated-text behavior, and visibility of photo elements.
- [ ] Exercise chat switching, focus loss, scrolling, account change, and restart. Record where identity or sequence tracking becomes uncertain.
- [ ] Evaluate cropped screenshots/local OCR only if needed and separately permitted; sanitize fixtures before saving.
- [ ] Report the highest evidenced mode and whether original photos can be retrieved through ordinary UI actions. Keep sending disabled for this task.

**Acceptance:** We know what the actual Mac client exposes, and whether observation/drafts are reliable. This task does not claim automatic sending is safe, permitted, or implemented.

### Task 2 — Build a runnable local simulator and lifecycle

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `config/companion.example.json`, `src/{cli,app,config,domain}.ts`, `src/channels/{channel,simulator}.ts`, `src/model/{provider,fake}.ts`, `tests/lifecycle.test.ts`.

**Consumes:** Shared contracts in section 5. **Produces:** `npm run companion -- --channel simulator --dry-run`.

- [ ] Configure scripts: `companion` runs `tsx src/cli.ts`; `typecheck` runs `tsc --noEmit`; `test` runs `vitest run`; `build` compiles TypeScript. Pin compatible dependency versions.
- [ ] Write lifecycle tests for missing desktop permissions or chat binding on the desktop channel, simulator startup without credentials, invalid configuration, and SIGINT cleanup.
- [ ] Run `npm test -- tests/lifecycle.test.ts`; confirm failures reflect missing behavior.
- [ ] Implement typed configuration and the simulator. Fake model output must be explicitly labeled; simulator must never print “WeChat connected.”
- [ ] Run the lifecycle tests and `npm run typecheck`. Start and stop the simulator manually.
- [ ] Commit the runnable simulator and configuration examples.

**Acceptance:** A new checkout runs without a real account; invalid live settings fail before connection or sending.

### Task 3 — Implement the desktop adapter and guarded sending

**Files:** `src/channels/wechat.ts`, `src/channels/desktop/{client,identity,observations,send-guard}.ts`, `native/wechat-accessibility/`, `tests/desktop/{observations,identity,send-guard,media}.test.ts`.

**Consumes:** Task 1 evidence and `Channel`. **Produces:** Locally identified incoming observations, verified media where available, and explicitly uncertain submission outcomes.

- [ ] Write fixture-based tests for identical consecutive messages, outgoing echoes, system notices, recycled UI elements, scrollback, app restarts, permission denial, and mismatched account/chat identities.
- [ ] Write send-guard tests for wrong focus, changed chat, pending modal, nonempty composer, a conversation change between fill and send, and timeout after submit.
- [ ] Run `npm test -- tests/desktop`; confirm intended failures before implementation.
- [ ] Implement the Swift helper with only bound-chat observation and guarded actions; connect through structured stdio. Restrict modes in the application independently of model output.
- [ ] Implement photo access based on Task 1 evidence. Distinguish original bytes from thumbnail/crop and fail truthfully when neither is available.
- [ ] Return `unknown` for uncertain submissions. Treat an observed outgoing bubble as local evidence only, never a delivery receipt.
- [ ] Run tests and the live observe/draft modes. After separate explicit enabling of a send test, verify one approved reply in the bound conversation. Keep auto mode unavailable when identity checks are insufficient.
- [ ] Record actual limitations and commit only sanitized fixtures and source.

**Acceptance:** Observe/draft mode works reliably; any enabled send mode respects the tested guards. Read-only success does not count as automatic-send completion.

### Task 4 — Persist and assemble conversation turns

**Files:** `src/storage/{database,conversations}.ts`, `src/storage/migrations/001_initial.sql`, `src/runtime/{inbox,turns}.ts`, `tests/turns.test.ts`.

**Interface:** `ingest(message: IncomingMessage): Promise<"accepted" | "duplicate" | "ignored">`; completed groups emit `Turn` values.

- [ ] Write tests using a fake clock: photo then text, text then photo, duplicate delivery, self-echo, a continuous message burst, restart with an unfinished assembly window, and two distinct conversations.
- [ ] Run `npm test -- tests/turns.test.ts`; confirm the grouping and deduplication tests fail initially.
- [ ] Implement inbox persistence before acknowledgment, unique local observation keys with sequence reconciliation, bounded grouping windows, and one processing queue per conversation.
- [ ] Ensure repeated events do not restart the quiet window or create a second turn. Flush at the five-second maximum even when messages continue arriving.
- [ ] Run tests against temporary SQLite databases and verify replay after process restart.
- [ ] Commit ingestion and turn assembly.

**Acceptance:** A photo-caption pair produces exactly one generated turn, and redelivery does not trigger another generation.

### Task 5 — Add honest, controllable memory

**Files:** `src/storage/{memories,summaries}.ts`, `src/memory/{extract,retrieve,lifecycle}.ts`, `tests/memory.test.ts`.

**Interfaces:** `setMemoryConsent(conversationId, enabled)`, `listMemories(conversationId)`, `forgetMemory(conversationId, memoryId)`, and `retrieveMemories(conversationId, query, limit)`; all return promises and operate on one conversation only.

- [ ] Write tests for memory disabled, enabled persistence across restart, corrected preferences, irrelevant retrieval, cross-conversation isolation, and deletion during active generation.
- [ ] Run `npm test -- tests/memory.test.ts` and confirm intended failures.
- [ ] Implement sourced memory records and conservative extraction from user statements. Never promote the assistant's own guesses or fictional dialogue to user facts.
- [ ] Start retrieval with normalized keys, recency, and SQLite text search; do not add a vector database for this release.
- [ ] Implement context revisions and deletion behavior from section 8. Test that summaries and pending extraction cannot restore deleted facts.
- [ ] Run memory tests and commit the storage and lifecycle implementation.

**Acceptance:** Memory is off by default, survives restart when enabled, and can be corrected or removed without reappearing from stale context.

### Task 6 — Adapt 狗头军师 and add text/image generation

**Files:** `references/goutoujunshi/`, `docs/upstream-provenance.md`, `prompts/*`, `src/companion/{context,guidance,output}.ts`, `src/model/remote.ts`, `src/media/images.ts`, `tests/{context,images,reply-schema}.test.ts`.

**Consumes:** `Turn`, selected history/memory, source references. **Produces:** Validated `Reply` through `ModelProvider.generate`.

- [ ] Pin the upstream revision, inspect its license, preserve required notices, and record original paths and local adaptations.
- [ ] Write the persona and 12 original examples described in section 6. Keep reference documents separate from top-level instructions.
- [ ] Write tests for context budgets, instruction-like text in a received message, malformed model output, too many bubbles, oversized bubbles, corrupt media, oversized decoded images, and unavailable media.
- [ ] Run `npm test -- tests/context.test.ts tests/images.test.ts tests/reply-schema.test.ts` and confirm intended failures.
- [ ] Implement image checks, orientation handling, and provider-compatible encoding. Do not fetch arbitrary URLs found in user messages; resolve only authenticated channel media references.
- [ ] Implement the provider adapter using its current documented API and structured-output support. Validate `{ "bubbles": ["..."] }` with Zod. Allow one repair attempt for invalid output; otherwise send a brief truthful fallback.
- [ ] Implement timeouts, token budgeting, usage recording when available, and deletion of temporary media on success or failure.
- [ ] Run unit tests plus an explicitly labeled live model smoke test with a non-private fixture image. Commit prompts, attribution, and generation code.

**Acceptance:** The model can respond to an actual image in natural Chinese without leaking analysis, fabricating unseen content, or reproducing the adviser's questionnaire.

### Task 7 — Compose the agent and terminal controls

**Files:** `src/runtime/{orchestrator,events,terminal}.ts`, `src/app.ts`, `tests/orchestrator.test.ts`, `tests/terminal.test.ts`.

**Consumes:** Inbox turns, memory/context services, provider, and channel. **Produces:** Persisted reply proposals and operational events.

- [ ] Write tests for receive-to-proposal processing, model timeout, memory revision change, paused state, and log redaction.
- [ ] Run `npm test -- tests/orchestrator.test.ts tests/terminal.test.ts`; confirm intended failures.
- [ ] Compose generation through the shared interfaces. A new turn waits for the preceding turn in the same conversation; recheck context revision before creating an outbound proposal.
- [ ] Add events: `channel.connected`, `channel.disconnected`, `message.received`, `turn.assembled`, `context.loaded`, `model.started`, `model.completed`, `reply.queued`, `reply.sent`, `reply.failed`, `reply.unknown`, and `memory.changed`.
- [ ] Display timestamps, counts, durations, and redacted identifiers. In non-interactive terminals output newline-delimited JSON; do not rely on screen clearing.
- [ ] Implement live controls: `/status`, `/pause`, `/resume`, `/memory list`, `/memory on`, `/memory off`, `/memory forget <id>`, `/history clear`, and `/quit`.
- [ ] `/history clear` also invalidates summaries and pending work; it leaves separately consented memories unless the user removes them. Print that distinction explicitly.
- [ ] Run tests and manually inspect terminal output with Chinese characters, errors, and reconnects. Commit the runtime.

**Acceptance:** The terminal exposes true state and useful controls without printing private reasoning, credentials, or full conversation contents by default.

### Task 8 — Deliver replies reliably

**Files:** `src/runtime/outbox.ts`, `tests/outbox.test.ts`, `tests/restart.test.ts`.

**Consumes:** `Reply` proposals and `Channel.sendText`. **Produces:** Ordered sends and durable per-bubble delivery status.

- [ ] Write tests for bubble ordering, pause between bubbles, definitive transient failure, unknown delivery, restart during sending, a deleted memory invalidating a queued reply, and SIGINT while a send is in flight.
- [ ] Run `npm test -- tests/outbox.test.ts tests/restart.test.ts`; confirm intended failures.
- [ ] Implement transactional outbox creation and claim-before-send. Retry only explicit failures that the adapter can establish did not deliver; apply at most three total attempts with backoff and connector limits.
- [ ] On unknown delivery, stop the remaining bubbles for that turn and surface the unresolved state. Add `/outbox` and `/outbox resolve <id> sent|discard` so the operator can reconcile it without an automatic duplicate.
- [ ] Check pause and context revision immediately before each send. Pause stops new sends; report if an already in-flight request cannot be recalled.
- [ ] Implement `--dry-run` through the same generation path but without channel sends. Mark proposals visibly as unsent.
- [ ] Run tests, including a process-kill/restart integration test. Commit the outbox implementation.

**Acceptance:** Multi-bubble replies arrive in order; failures and uncertain delivery are visible; restart does not blindly resend possible successes.

### Task 9 — Evaluate the personality and live workflow

**Files:** `tests/fixtures/evaluation-cases.json`, `tests/e2e.test.ts`, `docs/evaluations/companion-rubric.md`, `docs/runbook.md`, `README.md`.

- [ ] Create 20 original evaluation scenarios covering casual chat, image sharing, humor, comfort, disagreement, familiarity, correction, deletion, unavailable images, and requests for space.
- [ ] Run deterministic end-to-end tests with fake model and channel implementations. Verify boundaries and state, not exact creative wording.
- [ ] Evaluate live model responses separately on natural Chinese, relevance, character consistency, memory accuracy, and appropriate warmth. Score each from 1–5 and retain concise examples with model/version/prompt revision.
- [ ] Require zero fabricated memory claims, zero unseen-image descriptions, and zero unwanted sends in the evaluation set. Aim for at least 4/5 average on naturalness and relevance; inspect low-scoring cases before changing prompts.
- [ ] Run the real photo-plus-caption WeChat demonstration, restart continuity test, pause test, disconnect/reconnect test, and uncertain-delivery test where the transport permits simulation.
- [ ] Record measured latency to first bubble, model token usage when reported, and limitations. Do not infer a reliable price without checking the provider's current pricing.
- [ ] Write exact installation, configuration, startup, authentication, memory, deletion, recovery, and filming instructions. Document connector host requirements and where message/image data goes.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`; inspect outputs before claiming completion. Commit the runbook and evaluation results.

**Acceptance:** The first successful demonstration in section 1 works end to end with the actual WeChat route. If only simulation works, report the core as ready and the WeChat milestone as incomplete.

## 10. Example contract tests

These excerpts establish intended assertions; tests in their owning tasks must construct real temporary storage and fake time rather than mock away the state transitions.

```ts
// Reply shape; owned by Task 6.
import { expect, test } from "vitest";
import { ReplySchema } from "../src/companion/output";

test("accepts short Chinese bubbles", () => {
  expect(ReplySchema.parse({ bubbles: ["这只猫看起来很会享受生活", "你在哪儿遇到它的？"] })
    .bubbles).toHaveLength(2);
});

test("rejects empty or excessive bubble output", () => {
  expect(ReplySchema.safeParse({ bubbles: [] }).success).toBe(false);
  expect(ReplySchema.safeParse({ bubbles: ["1", "2", "3", "4", "5"] }).success)
    .toBe(false);
});

test("rejects oversized individual bubbles", () => {
  expect(ReplySchema.safeParse({ bubbles: ["好".repeat(121)] }).success).toBe(false);
});
```

For time, network, and persistence behavior, use scenario assertions recorded in Tasks 3–8 rather than exact text snapshots. No automated test can establish that a companion is emotionally compelling; the human dialogue evaluation is a separate requirement.

## 11. Intended operator workflow

Commands below are the target interface to implement; they do not exist yet.

```bash
# Development without a real WeChat connection
npm run companion -- --channel simulator --dry-run

# Read-only observation: no model calls or UI writes
npm run companion -- --channel wechat --mode observe

# Generate terminal drafts without writing into WeChat
npm run companion -- --channel wechat --mode draft

# Approve each proposed send in the terminal
npm run companion -- --channel wechat --mode manual

# Later milestone: starts disarmed and requires explicit session arming
npm run companion -- --channel wechat --mode auto
```

Example terminal output uses operational facts only:

```text
20:31:02  Desktop chat bound · session …a91 · sending disarmed
20:31:05  Received image + text · assembled 2 messages
20:31:05  Context ready · 6 recent turns · 2 memories · emotional-support
20:31:05  Model request started
20:31:08  Reply ready · 3 bubbles
20:31:09  Reply awaiting terminal approval
20:31:12  Sending armed for this approved reply
20:31:13  Bubble 1/3 submitted · outgoing UI observation confirmed
```

If a connector only acknowledges local submission, display “submitted” rather than “delivered.” Connection labels and receipts must reflect what the adapter can actually prove.

## 12. Sequence and release boundaries

1. **Desktop evidence:** Task 1 establishes observation reliability and permitted operating modes on the actual Mac client.
2. **Local foundation:** Task 2 can proceed independently of unresolved WeChat access.
3. **Core behavior:** Tasks 4–6 build persistence, memory, persona, and vision using the simulator.
4. **Live integration:** Task 3 supplies the verified transport; Tasks 7–8 connect runtime and delivery.
5. **Release evidence:** Task 9 validates both dialogue quality and the real phone-to-terminal workflow.

Do not estimate the live integration schedule until Task 1 is complete. The connector is the highest-uncertainty dependency; the language-model loop is not the primary unknown.

Deferred beyond the first release: proactive scheduled messages, voice notes, generated images, sticker sending, group chat, public deployment, local-model hosting, fine-tuning, automatic upstream updates, and elaborate full-screen terminal UI. A received sticker may initially produce an unsupported-media event; do not claim sticker understanding without a tested implementation.

## 13. Outstanding decisions and completion checklist

The plan can be reviewed now. Execution will need an evidence-backed connector choice, the model provider and credentials, an allowed conversation identity, and confirmation of any additional host/account requirement discovered in Task 1. These are inputs to specific tasks, not reasons to invent integrations in advance.

- [ ] Desktop observation/send capability evidence and unresolved platform-permission status recorded.
- [ ] Terminal launch and controls work on the chosen host.
- [ ] Text plus photo produces one contextual turn and short Chinese replies in actual WeChat.
- [ ] 狗头军师 provenance and license retained; persona is an adaptation, not a copied adviser workflow.
- [ ] Persistent history and optional memory survive restart and honor correction/deletion.
- [ ] Self-echo, duplication, timeout, disconnect, pause, and uncertain delivery tests pass.
- [ ] No credentials, private chat fixtures, or raw images are committed.
- [ ] Chinese dialogue evaluation completed with recorded results.
- [ ] Runbook is sufficient for another person to launch and recover the application.
- [ ] A real end-to-end demo is recorded or observed; simulator output is never presented as live WeChat integration.
