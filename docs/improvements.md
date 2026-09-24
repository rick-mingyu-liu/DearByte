# Potential improvements

What could make DearByte better, roughly in the order worth doing. [how-it-works.md](how-it-works.md) explains the system as it is; [plan.md](plan.md) tracks what's built. The size column is a rough guess: **S** under an hour, **M** a day or less, **L** several days.

## Fix soon

| What | Why | Size |
|---|---|---|
| Vary the openers of messages she writes first | 3 of 8 test good-mornings said 「今天周四」. Pass her last few openers in, as replies already do with 「最近说过的话」. | S |
| Catch up after a resync | When the chat table jumps ("聊天记录跳动了"), messages in that gap are skipped. The runner could compare the rows with the stored history and answer what's missing. | M |

## Personality and replies

| What | Why | Size |
|---|---|---|
| Bake-off cases from real chats | The best test cases came from live messages (「在干嘛」「今天下午还挺忙碌」). Add a few each week, especially ones where she sounded off. | S |
| Watch the tsundere balance | Too much 「哼」「才不是」 turns into a routine. Count those markers in the bake-off, the way warmth and emojis are counted now. | S |
| Photo bake-off | Photo replies are untested with the current persona. It needs 2–3 real photos in `data/test-images/`. | S |
| A stronger model for replies only | deepseek-flash sometimes goes generic. Any provider can now be set, but one model does everything. A second setting for the reply model, with a cheap one still doing memory, summary and the safety check, would help. Compare with `npm run bakeoff -- --provider … --model …` first. | S |

## Memory

| What | Why | Size |
|---|---|---|
| Memory search | Every fact goes into every prompt. Past about 100 facts, pick the relevant ones instead (SQLite FTS5 first; embeddings only if that isn't enough). | M |
| Longer-range summary | The rolling summary is 400 characters, so weeks of chat blur. Keep a weekly summary as well, and fold older weeks into a "long ago" line. | M |
| Memory per contact | Needed before 小拜 can talk to more than one person. Each contact gets their own facts, summary and proactive state, plus switching between chats in WeChat. | L |

## Reliability

| What | Why | Size |
|---|---|---|
| A daily spending cap too | The $1 cap is per reply. A runaway loop of many cheap replies isn't capped. A daily total (for example $5) would close that. | S |
| Start at login and restart on crash | Today the runner is started by hand. A `launchd` agent would bring 小拜 back after a reboot or a crash. | S |
| Set up the phone alert | `COMPANION_ALERT_URL` (ntfy) is built but not configured. The Mac notification alone is easy to miss. | S |
| Tests for the Swift helper | The helper is only tested by hand against real WeChat. Saved snapshots of the chat would let its parsing and alignment be tested offline. | M |

## Features

| What | Why | Size |
|---|---|---|
| Voice messages | She can only say she got one. Needs WeChat's SILK audio decoded, then speech recognition. | L |
| Stickers | Needs a Mac dedicated to 小拜 with WeChat in front (see [wechat-transport.md](design/wechat-transport.md)). | L |
| Typing status | WeChat for Mac doesn't show 「对方正在输入…」 from the background (tested). It's untested with WeChat in front, so only worth trying on a dedicated Mac. | S to try |

## If it becomes a product

| What | Why | Size |
|---|---|---|
| An official channel | The WeChat automation breaks Tencent's rules and is tied to WeChat 3.8.4. A mini program, an app, or iLink would reuse the persona, memory and safety code. | L |
| Registration and privacy | A public companion in China needs 生成式AI备案 registration and clear data handling. The model provider can now be switched to fit where users are. | L |
| Packaging | npm or a Homebrew tap, a first-run setup wizard, and a warning to use a separate WeChat account. | M |
| Safety review | Grow the crisis test set, and have a person review how 小拜 handles hard conversations before strangers use it. | M |
