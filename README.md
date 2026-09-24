# DearByte

A Chinese-speaking AI companion, 小拜 (嘴贫但细心), with persistent memory. It's built for a Douyin demo in which you chat with it in WeChat.

**Status:** the companion core works in a terminal simulator. The WeChat connection isn't built yet. See [the transport notes](docs/design/wechat-transport.md).

## Setup

Requires Node 24+.

```bash
npm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # gitignored
```

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
src/companion/           turn pipeline, prompt building, reply validation, safety check
src/memory/extract.ts    fact extraction and validation
src/storage/store.ts     SQLite (node:sqlite): messages, facts, settings
src/model/               DeepSeek client and fake model
tools/bakeoff.ts         persona bake-off
tools/inspect-wechat.swift  read-only WeChat accessibility probe
docs/                    original plan, provenance, design notes
```

## Data and privacy

Everything is stored locally in `data/` (gitignored). Each message is sent to DeepSeek to generate the reply; photos are sent only for the current turn. Deleting local data doesn't delete messages already sent in WeChat, or anything DeepSeek keeps on its side.

Persona ideas are adapted from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi) (MIT). See [docs/upstream-provenance.md](docs/upstream-provenance.md).
