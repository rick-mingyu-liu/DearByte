# Upstream provenance

## 狗头军师 (goutoujunshi)

- Source: https://github.com/shengjidaguai-china/goutoujunshi
- Revision reviewed: `6db7354a4002dc7c448a9c87ffdad8132570c9d3` (2026-09-15)
- License: MIT, Copyright (c) 2026 powerycy

### How it is used

Used as design reference only. No upstream files are vendored and no text is copied verbatim. The skill's adviser workflow (intake questionnaire, MBTI and 0–100 scoring, strategy reports, multi-option advice) is intentionally **not** used.

The following files informed the conversational rules in `prompts/persona.zh-CN.md` and the original examples in `prompts/dialogue-examples.zh-CN.json`:

| Upstream file | Ideas adapted |
|---|---|
| `references/practical/巧妙接话技巧：让沟通更流畅的实用指南.md` | Answer the emotion, not just the literal words; build on keywords; avoid replies that end the conversation |
| `references/practical/场景感、松弛感与社交校准：从接话到关系推进.md` | The 接/放/给/抛 turn structure; the anti-"interview" rule; green/yellow/red calibration; what is and isn't fair game for teasing |
| `references/practical/为他人提供情绪价值：温暖且有效的回应指南.md` | Emotion before content; no lecturing or dismissing; specific praise; remembering small things |
| `references/practical/废话文学回复指南：轻松应对各类场景.md` | Light banter in low-stakes moments, never for important topics |
| `references/practical/化解尴尬：轻松救场的实用指南.md` | Self-deprecation when wrong; no triple apologies |
| `references/knowledge/17-中国法律安全与危机转介.md` | What counts as a crisis signal; directing people to 110/120 in `prompts/safety.zh-CN.md` |

### Deliberate deviations

The upstream guides often suggest "share a similar experience of your own" (我上次也……). The companion is an openly fictional AI, so the persona replaces this with opinions, observations from the conversation, and remembered history. It never invents human experiences.

If upstream text is ever vendored into `references/goutoujunshi/`, include the upstream `LICENSE` file alongside it.

## Tencent `@tencent-weixin/openclaw-weixin` (iLink protocol)

- Source: https://github.com/Tencent/openclaw-weixin (npm package version 2.4.9)
- License: MIT, Copyright (C) 2026 Tencent. The notice is copied to `docs/third-party/openclaw-weixin-LICENSE`, because `src/channels/ilink/` closely follows parts of it.

### How it is used

It is the protocol reference for `src/channels/ilink/`. OpenClaw is **not** installed or imported, and no upstream files are vendored.

Short protocol helpers are re-implemented from it, and are close to the original:

- request headers and `base_info`
- the client-version encoding
- the lossless uint64 ID parser
- AES key parsing

The following come from it: endpoint names, body shapes, QR status values, and the retry and backoff constants.

### Deliberate deviations

- **What we implement:** only QR login, getting updates, downloading and decrypting photos, sending text, and the typing indicator. We don't support outgoing media, multiple accounts, pairing, slash commands, or the quote store.
- **`bot_agent`:** set to `DearByte/…`. `iLink-App-Id` and `channel_version` still mirror the protocol version we implement.
- **Who gets replies:** only the user who scanned the QR code (`ilink_user_id`). Upstream uses a configurable allow list.
- **Bursts:** several quick messages are merged into one turn. Upstream answers each one.
