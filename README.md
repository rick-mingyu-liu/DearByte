# DearByte

A Chinese-speaking AI companion, 小拜 (嘴贫但细心), with persistent memory. It's built for a Douyin demo in which you chat with it in WeChat.

**Status** ([full plan](docs/plan.md)):
- The companion works in a terminal simulator.
- A WeChat connection is written and unit-tested, but hasn't been tried against real WeChat yet. It uses iLink, the official API behind 微信 ClawBot, and doesn't need OpenClaw. See [the transport notes](docs/design/wechat-transport.md).

## Setup

Requires Node 24+.

```bash
npm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # gitignored
```

## Chat in WeChat

```bash
npm run dearbyte              # first run: scan the QR code with your phone's WeChat
npm run dearbyte -- --fake    # test the connection without model calls (replies are labelled fake)
npm run dearbyte -- --login   # scan again
npm run dearbyte -- --logout  # delete the saved login
```

1. Scan the QR code and confirm on your phone.
2. A contact called **微信 ClawBot** appears in WeChat. You can give it the remark (备注) "小拜".
3. Chat with that contact; the terminal shows each message, each bubble sent, and the per-turn log lines.

The terminal also accepts the `/memory`, `/history clear` and `/status` commands.

How the WeChat connection behaves:
- **Who gets replies:** only the WeChat user who scanned the code. Group messages and other senders are ignored.
- **Bursts:** several quick messages (within about 1.5 s) become one turn.
- **Media:** photos are downloaded and decrypted. Voice messages use WeChat's own transcript. Files and videos are described to 小拜 as things it can't open.
- **Replies:** bubbles are sent one at a time, with the typing indicator between them.
- **Login storage:** the login is saved in `data/wechat-account.json` (gitignored, mode 600). The bot can't start a conversation; it only replies.

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
| `COMPANION_WECHAT_ACCOUNT` | `data/wechat-account.json` |

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
src/wechat.ts            WeChat runner
src/console.ts           terminal commands and log lines shared by both
src/channels/ilink/      iLink client: login, long-poll, photos, send, bridge to the companion
src/companion/           turn pipeline, prompt building, reply validation, safety check
src/memory/extract.ts    fact extraction and validation
src/storage/store.ts     SQLite (node:sqlite): messages, facts, settings
src/model/               DeepSeek client and fake model
tools/bakeoff.ts         persona bake-off
tools/inspect-wechat.swift  read-only WeChat accessibility probe (desktop fallback only)
docs/plan.md             plan: decisions, status, milestones
docs/                    provenance, design notes, third-party notices
```

## Data and privacy

Everything is stored locally in `data/` (gitignored). Each message is sent to DeepSeek to generate the reply; photos are sent only for the current turn. In WeChat mode, Tencent relays the messages. Under the ClawBot terms, we (the AI service) are responsible for how that content is processed. Deleting local data doesn't delete messages already sent in WeChat, or anything DeepSeek keeps on its side.

Persona ideas are adapted from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi) (MIT). See [docs/upstream-provenance.md](docs/upstream-provenance.md).
