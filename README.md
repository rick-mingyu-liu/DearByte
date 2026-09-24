# DearByte

A Chinese-speaking AI companion, 小拜 (嘴贫但细心), with persistent memory. It's built for a Douyin demo in which you chat with it in WeChat.

**Status** ([full plan](docs/plan.md)):
- The companion works in a terminal simulator.
- 小拜 runs on **a real WeChat account with its own name and avatar**. WeChat for Mac, logged in as 小拜, is driven through macOS Accessibility. Text and photos were tested live on 2026-09-24. See [the transport notes](docs/design/wechat-transport.md) for how it works and the risks.

## Setup

Requires Node 24+.

```bash
npm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # gitignored
```

## Chat in WeChat (the real 小拜 account)

You need:
- **WeChat for Mac 3.8.4 with the English UI, logged in as 小拜.** Don't update it: WeChat 4.x encrypts received images.
- **Accessibility permission** for your terminal app (System Settings → Privacy & Security → Accessibility).
- **Swift** (Xcode Command Line Tools). The helper in `native/wechat-desktop/` is built automatically on first run.
- **The chat with you open** in WeChat's main window, scrolled to the bottom. The window can sit on another desktop (Space), but don't close it, and don't open chats in separate windows.

```bash
npm run dearbyte -- --chat 张三   # first run: bind the chat to answer (the name shown at the top of the chat)
npm run dearbyte                  # later runs: the bound chat is remembered
npm run dearbyte -- --draft       # generate replies in the terminal without sending them
npm run dearbyte -- --fake        # no model calls; replies are labelled fake
```

Then chat with 小拜 from your phone. The terminal shows each message, each bubble sent, and the per-turn log lines. Terminal commands:

| Command | What it does |
|---|---|
| `/pause`, `/resume` | Stop and restart replies. Messages that arrive while paused are skipped, not answered later. |
| `/memory …`, `/history clear` | Same as in the simulator (below) |
| `/status`, `/help`, `/quit` | Show status, show help, quit |

How it behaves:
- **Who gets replies:** only the bound one-to-one chat. If you open another chat on the Mac, 小拜 waits until it's back. Messages already in the chat when it starts are never answered. If a second person speaks in the chat (a group), it pauses.
- **Bursts:** several quick messages (within about 1.5 s) become one turn.
- **Photos:** read from WeChat's local image folder for that chat (`COMPANION_WECHAT_MEDIA_DIR`). Without it, 小拜 is told it can't see the picture. Stickers, voice, video and files are described to 小拜 as things it can't open.
- **Sending:** the helper types each bubble into the composer and presses Return, then confirms the bubble appeared. It never sends while someone has a draft in the composer, and never resends a bubble it couldn't confirm.

**Risk:** Tencent doesn't allow automating WeChat. The 小拜 account could be restricted, so use a test account, not your personal one. This route is for the demo only and can't be part of a product.

## Chat in the terminal

```bash
npm run companion            # real model (deepseek-flash)
npm run companion -- --fake  # offline; replies are labelled fake
```

You type as the WeChat user. Terminal commands:

| Command | What it does |
|---|---|
| `/img <path> [配文]` | Send a photo (JPEG, PNG, WebP, or HEIC via macOS `sips`). You can drag the file into the terminal. |
| `/memory` | List what 小拜 remembers |
| `/memory on` / `off` | Turn long-term memory on or off. It is **off by default**. |
| `/memory forget <id>` | Delete one memory. Older messages cannot bring it back; restating it later can. |
| `/memory export` | Write memories to `data/memory-export.md` |
| `/history clear` | Delete chat history. Memories are kept. |
| `/status`, `/help`, `/quit` | Show status, show help, quit |

Grey lines show what happened on each turn: context used, model latency, tokens and cost, and memory changes.

## How a reply is made

```text
message ─► SQLite (history) ─► prompt ─► deepseek-flash ─► check reply ─► bubbles
                                 │                            │
         persona + examples ─────┤          invalid? one repair, then clip/fallback
         now / memory status ────┤
         remembered facts ───────┤
         safety prompt (crisis) ─┘
                                                     after reply ─► extract facts ─► SQLite
```

- It is **not an agent**: the model has no tools and never chooses actions. Code decides what is stored and sent.
- **Memory** is a table of short facts. A background call proposes facts after each turn. A fact is kept only if its evidence is a verbatim quote of the user's message, so the model's own guesses never become memories. All active facts go into the prompt, up to 100; past events drop out 7 days after their date.
- **Safety:** crisis keywords add `prompts/safety.zh-CN.md`. It asks whether the user is safe, says the bot can't call anyone, and points to 110 / 120 / 12356.

## Configuration (`.env`)

| Variable | Default |
|---|---|
| `DEEPSEEK_API_KEY` | required, unless you use `--fake` |
| `DEEPSEEK_MODEL` | `deepseek-flash` (supports vision) |
| `COMPANION_DB` | `data/companion.sqlite` |
| `COMPANION_TZ` | `Asia/Shanghai` (used to resolve dates like 下周六) |
| `COMPANION_HISTORY_MESSAGES` | `40` (the last 20 turns, verbatim) |
| `COMPANION_WECHAT_MEDIA_DIR` | unset. The `…/<小拜 account>/Message/MessageTemp/<chat>/Image` folder inside WeChat's container; needed for photos. |

## Development

```bash
npm test             # vitest, no network
npm run typecheck
npm run bakeoff      # live persona test → data/bakeoff/*.md (about $0.004 per run)
npm run bakeoff -- --case cat-photo --runs 3
```

For the photo test cases, put photos at `data/test-images/cat.jpg` and `data/test-images/food.jpg`.

## Layout

```text
prompts/                 persona, examples, safety prompt
src/cli.ts               terminal simulator
src/dearbyte.ts          WeChat runner (npm run dearbyte)
src/console.ts           terminal commands and log lines shared by both
src/channels/reply-loop.ts  bursts, turns and bubble-by-bubble sending, for any channel
src/channels/desktop/    WeChat for Mac: reading rows, finding photos, sending
native/wechat-desktop/   Swift Accessibility helper (JSON lines over stdin/stdout)
src/companion/           turn pipeline, prompt building, reply validation, safety check
src/memory/extract.ts    fact extraction and validation
src/storage/store.ts     SQLite (node:sqlite): messages, facts, settings
src/model/               DeepSeek client and fake model
tools/bakeoff.ts         persona bake-off
tools/inspect-wechat.swift  read-only WeChat accessibility probe
docs/plan.md             plan: decisions, status, milestones
docs/                    provenance and design notes
```

## Data and privacy

Everything is stored locally in `data/` (gitignored). Each message is sent to DeepSeek to generate the reply; photos are sent only for the current turn. In WeChat mode, the runner reads only the bound chat and its image folder, and Tencent carries the messages as it does for any chat. Deleting local data doesn't delete messages already sent in WeChat, or anything DeepSeek keeps on its side.

Persona ideas are adapted from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi) (MIT). See [docs/upstream-provenance.md](docs/upstream-provenance.md).
