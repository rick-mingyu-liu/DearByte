[简体中文使用指南](guide.zh-CN.md) · [English README](../README.en.md)

# DearByte · 小拜 — Operations guide

A Chinese-speaking AI companion, 小拜 (傲娇但细心, a tsundere girl), with persistent memory. It's built for a Douyin demo in which you chat with it in WeChat.

**Status** ([full plan](plan.md)):
- The companion works in a terminal simulator.
- 小拜 runs on **a real WeChat account with its own name and avatar**. WeChat for Mac, logged in as 小拜, is driven through macOS Accessibility. Text and photos were tested live on 2026-09-24. See [the transport notes](design/wechat-transport.md) for how it works and the risks.
- It remembers facts, how you want it to talk, and a rolling summary of older chat. It sometimes writes first (good mornings, luck on exam days, check-ins), and it checks every message for crisis signals.

**New here?** Read [how it works](how-it-works.md) first.

## Setup

Requires Node 26+ (`nvm use` picks it from `.nvmrc`).

```bash
npm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # gitignored
```

## Chat in WeChat (the real 小拜 account)

You need:
- **WeChat for Mac 4.x (tested on 4.1.13) or 3.8.4, with the English UI, logged in as 小拜.** On 4.x, photos are cut out of WeChat's window, so the terminal needs the Screen Recording permission (System Settings → Privacy & Security → Screen & System Audio Recording) and the chat must be scrolled to the bottom. Run one copy of the runner at a time: a second one refuses to start, because two would answer each other.
- **Accessibility permission** for your terminal app (System Settings → Privacy & Security → Accessibility).
- **Swift** (Xcode Command Line Tools). The helper in `native/wechat-desktop/` is built automatically on first run.
- **The chat with you open** in WeChat's main window, scrolled to the bottom. The window can sit on another desktop (Space), but don't close it, and don't open chats in separate windows.

```bash
npm run dearbyte -- --chat 张三   # first run: creates data/contacts.json for this chat (the name shown at the top of the chat)
npm run dearbyte                  # later runs read data/contacts.json
npm run dearbyte -- --draft       # generate replies in the terminal without sending them
npm run dearbyte -- --film        # a clean log for the camera: the conversation, 小拜 writing first, and what it remembers
npm run dearbyte -- --fake        # no model calls; replies are labelled fake
npm run dearbyte -- --memory on   # turn long-term memory on (or off); remembered
npm run dearbyte -- --proactive off  # 小拜 never writes first; on by default, remembered
```

Then chat with 小拜 from your phone. The terminal shows each message, each bubble sent, and the per-turn log lines. Terminal commands:

| Command | What it does |
|---|---|
| `/pause`, `/resume` | Stop and restart replies. Messages that arrive while paused are skipped, not answered later. |
| `/proactive on` / `off` | Whether 小拜 writes first (below) |
| `/memory …`, `/history clear` | Same as in the simulator (below) |
| `/status`, `/help`, `/quit` | Show status, show help, quit |

### Set the allowed contact

1. In the main Mac WeChat window signed in as Xiaobai, open the one-to-one conversation Xiaobai should answer.
2. Use the name shown at the top of that chat, quoted in full (including any spaces):

```bash
npm run dearbyte -- --chat "Alex Zhang" --draft
```

On first setup, the runner checks the open chat's name and creates `data/contacts.json`. `--draft` generates replies without sending them so you can check the setup. Once ready, quit and run `npm run dearbyte` to enable automatic replies.

To allow **other display names for the same person**, edit `data/contacts.json` under the project root:

```json
{
  "contacts": [
    {
      "id": "me",
      "names": ["张三", "Alex Zhang"]
    }
  ]
}
```

Replace these example aliases with the remark or nickname WeChat actually displays for that one person. `names` matches the title at the top of the chat, not the person's WeChat ID. The `id` field is an internal identifier; you can leave it as `me`. See [contacts.example.json](../contacts.example.json).

Save, quit, and restart with `npm run dearbyte`. Once the file exists, `--chat` does not append or overwrite contacts: edit the file directly. Only one contact is supported. Do not list different people as aliases or add a second contact object. History and memory are not isolated per contact yet; changing the allowlist does not create a fresh, separate conversation.

If Xiaobai keeps waiting, check that the current chat title exactly matches an entry in `names` and that you restarted after editing. The file is ignored by Git because it contains real names.

How it behaves:
- **Who gets replies:** only the one-to-one chat listed in `data/contacts.json`. The file is gitignored because it holds real names; `contacts.example.json` shows the format. List every name WeChat may show at the top of that chat (the remark, the nickname, old names), so renaming the chat doesn't stop replies. Edit the file and restart to change it. Only one contact is supported for now: several would need separate history and memory per person, and a way to switch chats.
- **Other chats:** if you open another chat on the Mac, 小拜 waits until it's back. Messages already in the chat when it starts are never answered. If a second person speaks in the chat (a group), it pauses.
- **Bursts:** several quick messages (within about 1.5 s) become one turn.
- **Timing:** the first bubble comes 1.5–3.5 s after the message at the earliest, as if reading it; later bubbles take about as long as typing them, with some jitter.
- **Photos:** read from WeChat's local image folder for that chat (`COMPANION_WECHAT_MEDIA_DIR`). Without it, 小拜 is told it can't see the picture. Stickers, voice, video and files are described to 小拜 as things it can't open.
- **Writing first:** 小拜 sometimes messages you unprompted, like a friend would:
  - a good morning on some days (about 6 in 10), at a random time between 8:00 and 9:30, if you haven't talked yet that day;
  - on the day of an event it remembers (an exam, an interview), some luck in the morning and a "how did it go?" in the evening (this needs memory on);
  - a check-in after 20 hours or more without hearing from you, in the afternoon;
  - on about 7 days in 10, a "just thought of you" message at a random time between 13:00 and 20:00, after 3 quiet hours: usually a question about something you told it.

  If you ask for space (「别给我发消息了」「让我静静」), it doesn't write first for 3 days. For 3 days after a message that looked like a crisis, anything it starts is only a gentle 「这两天缓过来点没」-style check-in. A message is stored in the chat history only once it has actually been sent. If you write while 小拜 is composing one, it's dropped and your message is answered instead. It never writes between 22:30 and 8:00, sends at most 2 a day, waits 90 minutes after a conversation, and never sends another until you've replied to the last one. It checks once a minute and only when the chat is open and replies aren't paused. Draft mode never writes first.
- **Alerts:** if 小拜 isn't answering for a minute (chat closed or renamed to a name not in the list, WeChat not running, the chat reading empty, or replies paused), you get a macOS notification with the reason, and another when it recovers. A bubble that can't be sent alerts too, at most once per 10 minutes. For alerts on your phone, set `COMPANION_ALERT_URL` to an [ntfy](https://ntfy.sh) topic URL (e.g. `https://ntfy.sh/<a-long-random-name>`) and subscribe to it in the ntfy app. The push says only that 小拜 stopped or recovered, never chat names; the details stay in the Mac notification. Make the topic name hard to guess anyway.
- **Staying awake:** the Mac is kept from idle sleep while 小拜 runs (`caffeinate`). The display can still sleep. Closing the lid still sleeps a MacBook unless it's on power with an external display.
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
| `COMPANION_PROVIDER` | `deepseek` (default). Also `openai`, `anthropic`, `gemini`, `qwen`, `moonshot` (Kimi), `zhipu` (GLM), `openrouter`, `ollama` (local), or `custom` (any OpenAI-compatible API). |
| `COMPANION_MODEL` | The model name. DeepSeek defaults to `deepseek-flash` (the old `DEEPSEEK_MODEL` still works); required for every other provider. |
| `COMPANION_API_KEY` | The key. Each provider's own variable works too: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `OPENROUTER_API_KEY`. Ollama needs none, and neither does `--fake`. |
| `COMPANION_BASE_URL` | Overrides the API address; required for `custom`. |
| `COMPANION_PRICE_INPUT`, `COMPANION_PRICE_OUTPUT`, `COMPANION_PRICE_CACHED` | USD per 1M tokens, as the provider publishes them. Built in for DeepSeek; Ollama is free. Required for any other paid model, or the spending cap can't work and the runner won't start. |
| `COMPANION_VISION` | `true` or `false`: whether the model reads images. By default it's guessed from the model's name (`vl`, `vision`, `gpt-4o`, `claude`, `gemini`, `glm-4.5v`, `llava` and so on), then from the provider. The startup line shows 能看图 or 看不了图. Without vision, 小拜 tells the user she can't see the photo. |
| `COMPANION_MAX_COST_PER_REPLY` | `1`. The most one reply may cost in USD, including repairs, the safety check, memory and the summary. Near the limit the output cap shrinks; past it, no more model calls. `0` turns it off. |
| `COMPANION_DB` | `data/companion.sqlite` |
| `COMPANION_ALERT_URL` | Optional. An ntfy topic URL for alerts on your phone. |
| `COMPANION_TZ` | The Mac's time zone. Used for 小拜's sense of time, dates like 下周六, and when it may write first. Set it to the chat partner's zone (e.g. `Asia/Shanghai`) if the Mac is elsewhere, or 小拜 may write to them at night. |
| `COMPANION_HISTORY_MESSAGES` | `40` (the last 20 turns, verbatim). Older messages are folded into a rolling summary when memory is on. |
| `COMPANION_HISTORY_DAYS` | `30`. Chat history older than this is deleted, once it's in the summary (memory on) or right away (memory off). `0` keeps everything. |
| `COMPANION_WECHAT_MEDIA_DIR` | unset. The `…/<小拜 account>/Message/MessageTemp/<chat>/Image` folder inside WeChat's container; needed for photos. |

To use another provider, for example Claude (prices as the provider publishes them):

```dotenv
COMPANION_PROVIDER=anthropic
COMPANION_MODEL=<model name from the provider's docs>
ANTHROPIC_API_KEY=<your key>
COMPANION_PRICE_INPUT=…
COMPANION_PRICE_OUTPUT=…
```

小拜's persona was tuned on DeepSeek, so another model may sound different. Compare first with `npm run bakeoff -- --provider anthropic --model <name>`.

## Development

```bash
npm test             # vitest, no network
npm run typecheck
npm run bakeoff      # live persona test with an AI-tone score → data/bakeoff/*.md (about $0.007 per run)
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
src/model/               provider clients (OpenAI-compatible, Anthropic), spending cap, fake model
tools/bakeoff.ts         persona bake-off
tools/inspect-wechat.swift  read-only WeChat accessibility probe
docs/how-it-works.md     start here: how the whole system works
docs/plan.md             plan: decisions, status, milestones
docs/improvements.md     what could be better, in rough order
docs/film/shot-list.md   the 30-second video, shot by shot
docs/                    provenance and design notes
```

## Data and privacy

Everything is stored locally in `data/` (gitignored): chat history (kept 30 days by default, see `COMPANION_HISTORY_DAYS`), memories, a rolling summary of older chat, and settings. Each message is sent to the configured model provider (DeepSeek by default) to generate the reply; photos are sent only for the current turn. In WeChat mode, the runner reads only the chat listed in `data/contacts.json` and its image folder, and Tencent carries the messages as it does for any chat. Deleting local data doesn't delete messages already sent in WeChat, or anything the provider keeps on its side.

Persona ideas are adapted from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi) (MIT). See [docs/upstream-provenance.md](upstream-provenance.md).
