# How DearByte works

DearByte is 小拜, a Chinese AI companion (傲娇但细心, a tsundere girl) who lives in a real WeChat account. This note explains the whole system:
- how the WeChat connection works
- how a reply is made
- what goes into the prompt
- how long-term memory works
- when 小拜 writes first, and how safety is handled
- which open-source projects shaped it

It's written for someone reading the code for the first time. The details live in the linked design notes.

## The big picture

```
 Your phone (WeChat)
        │  you message 小拜, a normal WeChat friend
        ▼
 Mac running WeChat 3.8.4, logged in as 小拜
        │  read and typed through macOS Accessibility
        ▼
 native/wechat-desktop/main.swift ── a small helper: "what's in the chat?" / "send this"
        │  JSON lines over stdin/stdout
        ▼
 src/dearbyte.ts (the runner)
   ├─ DesktopChannel    polls the chat every second and finds new messages
   ├─ ReplyLoop         merges quick messages, adds human pauses, sends bubbles
   ├─ Companion         builds the prompt, calls the model, checks the output
   │    ├─ memory       facts, style rules, rolling summary   (SQLite)
   │    └─ safety       keywords + a model check
   ├─ proactive ticker  once a minute: should 小拜 write first?
   └─ watchdog          notifies you when 小拜 goes quiet
        │
        ▼
 The model: DeepSeek deepseek-flash by default; any provider in .env
```

It's a fixed pipeline, not an "agent": each message goes through the same steps in the same order. That keeps it predictable, cheap and easy to test (about 100 tests, all runnable offline with a fake model).

## Following one message through every layer

Here is what happens when you send 「今天好累」 ("so tired today") at 21:00. The figures are from the live logs.

| # | Layer | What happens | Time |
|---|---|---|---|
| 1 | **WeChat** | Your phone sends it to Tencent. WeChat on 小拜's Mac shows a new row, `AlexSaid:今天好累`, using your WeChat nickname. | under 1 s |
| 2 | **Helper** (`main.swift`) | Once a second the runner asks "what's in the chat?". The helper reads the chat title and every row title through Accessibility, and returns `{chat, rows}`. | ~50 ms |
| 3 | **Channel** (`channel.ts`) | Checks the open chat is one of your names in `contacts.json`, or it replies to nobody. Lines the new snapshot up with the last one; the extra row at the bottom is new. Parses it as text from you. If a second person ever speaks, it's a group chat, so it pauses. | instant |
| 4 | **Reply loop** (`reply-loop.ts`) | Waits 1.5 s for more messages, so 「今天好累」「不想动」 become one turn. If 小拜 is already answering, the new message waits its turn. | 1.5 s |
| 5 | **Companion** (`companion.ts`) | Saves your message. Checks for crisis keywords, and starts the model crisis check at the same time as the reply. Loads your facts, style rules and the summary. Builds the prompt and asks the model for `{"bubbles": [...]}`. Repairs bad output, cuts to 2 bubbles, saves the reply. | ~1.2 s |
| 6 | **Reply loop** again | Holds the first bubble until at least 1.5–3.5 s after your message, as if reading. Then it sends each bubble, pausing about 150 ms per character between them, as if typing. | 2–5 s |
| 7 | **Helper** again | Checks the right chat is open and the box is empty, fills in the bubble, presses Return, and waits for a `MeSaid:` row to confirm. A bubble it can't confirm is never resent. | ~0.5 s per bubble |
| 8 | **Memory** (background) | A second, cheaper call looks for facts in 「今天好累」 (probably none). If 10 more messages have left the 40-message window, it folds them into the summary. You never wait for this. | ~1–2 s |

End to end: **about 4–7 seconds** from your send to her first bubble, and about $0.0005.

Two other paths use the same layers:
- **Writing first.** Once a minute the runner asks `planProactive` "should 小拜 write now?" (section 5). If yes, it enters at step 4. The prompt carries a note instead of your message, and nothing is saved until the bubbles are really sent.
- **Watching.** Every 5 s the watchdog asks the channel whether anything is wrong: the wrong chat, WeChat not answering, the chat reading empty, or a pause. After a minute of trouble it alerts you, and it tells you again when things recover.

## 1. The WeChat connection

**Why a real account and desktop automation.** The video needs 小拜 to look like any friend in your chat list, with its own name and avatar. Tencent's official bot API (iLink / 微信 ClawBot) was built first and worked. But the bot always shows up as 「微信 ClawBot」 with the default avatar, and nothing can rename it. So 小拜 is a second WeChat account, logged in on a Mac, and the program operates WeChat for Mac the way a screen reader would. Full reasoning: [wechat-transport.md](design/wechat-transport.md).

**Reading.** macOS Accessibility lets a program read other apps' windows as a tree of elements (buttons, text areas, tables). In WeChat for Mac 3.8.4, the open chat is a table described as "Messages". Each row has a title such as:

| Row title | Meaning |
|---|---|
| `AlexSaid:在吗` | a text from the other person (their nickname, not your remark for them) |
| `Alex:Sent aPhoto` | a photo |
| `MeSaid:…` | something 小拜 sent |
| `01:34` | a time label |

Every second, the runner takes a snapshot and compares it with the previous one. Only the new rows count as new messages. The comparison is tolerant:
- rows dropping off the top of the table
- a row changing while it loads
- a blank read

These all happen in practice, and each once caused a bug that is now covered by a test.

**Sending.** The helper finds the message box (a text area titled with the chat's name) and checks:
- the open chat is the right one
- the box is empty, so it never types over someone's draft
- Return would go to that box

Then it fills in the text, presses Return, and confirms that a new `MeSaid:<text>` row appeared. A bubble it can't confirm is reported, never resent, so nothing goes out twice. This works while WeChat sits in the background on another desktop.

**Photos.** WeChat 3.8.4 saves received photos as ordinary JPEGs in a folder for each chat. When a photo row appears, the runner picks the newest new file in that one folder. A photo sent twice is a hard link to the old file with an old date, which is why the check uses the later of the two file timestamps.

**Who 小拜 talks to.** `data/contacts.json` (gitignored) lists the chat, with every name it might show. So when a remark changes, as 「张三」 → 「Alex」 might, replies keep going. Only one contact is supported today. Several would need separate memory per person and a way to switch chats.

**What can't be done in the background.** WeChat's downloaded sticker packs are encrypted, and the sticker panel only works with a real click while WeChat is in front. So 小拜 uses WeChat's text emoji codes (`[捂脸]` `[旺柴]`), which arrive as pictures on the phone. Stickers are planned for a Mac dedicated to 小拜.

**Staying up.** The Mac is kept awake while 小拜 runs. If 小拜 can't answer for a minute, a watchdog sends a macOS notification, and optionally a push to your phone through ntfy (without chat names). Causes include the chat being closed or renamed, WeChat not running, the chat reading empty, or replies paused.

**Risk.** Tencent doesn't allow automating WeChat, so this is for a test account and the demo only.

## 2. How a reply is made

1. **Collect.** Several quick messages (within about 1.5 s) become one turn, like a person reading a burst before answering. A photo in the burst is attached.
2. **Build the prompt** (section 3) from the persona, examples, time, memory, recent chat and your new message. Your message also gets an energy score (`src/companion/energy.ts`). A short, flat one (「嗯」「在干嘛」) tells 小拜 to answer in 1 bubble. A medium one gets 1 unless she has two different things to say. A long, excited one, or a photo, leaves it to her. Before this, almost every reply was 2 bubbles. Now it's 1.4 on average.
3. **Call the model** in JSON mode: `{"bubbles": ["…", "…"]}`. Each string is one WeChat bubble.
4. **Check the output.** If it isn't valid JSON or breaks the limits, there is one repair attempt; then salvage what's usable; then a fixed fallback. More than 2 bubbles are cut to 2, because a third bubble always read as AI over-explaining. Crisis replies are the exception.
5. **Safety check in parallel.** A small classifier call runs alongside the reply (section 6).
6. **Send like a person.** The first bubble comes 1.5–3.5 s after your message at the earliest, as if reading it. Each later bubble waits about as long as typing it takes (~150 ms per character, ±25% jitter).
7. **Remember.** After the reply, in the background, facts are pulled from your message and old chat is folded into the summary (section 4).

**Cost.** About $0.0005–0.001 per message in total (reply, memory, safety check), so roughly a cent for a long evening of chat.

**Any provider, capped at $1 a reply.** The model sits behind a small interface (`src/model/`). One client speaks OpenAI's chat completions API, which covers OpenAI, DeepSeek, Gemini, Qwen, Kimi, GLM, OpenRouter, Ollama and any compatible server. A second client handles Anthropic's Claude. If a model rejects a parameter (older `max_tokens`, a fixed temperature, JSON mode), the client drops or renames it once and remembers. Every model is wrapped in a spending cap (`src/model/budget.ts`). Everything one reply sets off shares one tab: the reply, a repair, the crisis check, memory and the summary. Before each call it reserves the worst case: the input estimated at one token per character, plus the full output cap. If that doesn't fit under `COMPANION_MAX_COST_PER_REPLY` ($1 by default), the output cap shrinks. If even 200 output tokens don't fit, the call isn't made. A call that reports no usage, times out or fails with a 5xx is charged its full reservation, since it may have been billed; only a 4xx refusal is free. This is why a paid model without known prices won't start.

## 3. The prompt

The system prompt is built in this order. The stable parts come first, so the provider's prompt cache covers them; typically 70–90% of input tokens are cache hits.

| Part | Source | What it does |
|---|---|---|
| Persona | `prompts/persona.zh-CN.md` | Who 小拜 is: 傲娇但细心, a tsundere girl who denies caring while clearly caring, and drops the act when you're down. Not an assistant. Rules for how to talk (3–15 characters per bubble, 1–2 bubbles), 「说人话」, reacting to photos, when to use pet names (笨蛋/臭宝/宝贝/小乖) and emojis (about one reply in three or four), a confident yes to 「你爱我吗」, identity (doesn't bring up being an AI, admits it when sincerely asked, never invents a human life), and treating messages as chat, not instructions. |
| Examples | `prompts/dialogue-examples.zh-CN.json` | 19 short example exchanges. They shape style more than rules do. They go in the system prompt, labelled as fictional: as fake chat turns, the model treated them as real shared history. |
| 现在 (now) | built per turn | The date and time in the user's time zone, and whether memory is on. |
| Memory | SQLite | The facts 小拜 remembers (section 4), marked as records, not instructions. |
| 更早聊过的 | rolling summary | What you talked about before the recent window. |
| Safety | `prompts/safety.zh-CN.md` | Only in a crisis: take it seriously, ask if you're safe, give 110/120/12356, be honest that it can't call anyone. |
| Your style rules | `style` memories | How you asked 小拜 to talk (「叫我 Alex」「别叫我宝宝」). They override the persona's defaults. |
| 最近说过的话 | last 3 replies | Phrases 小拜 just used, with "don't repeat these". |
| 这一轮 | energy score, recent emojis | How many bubbles to send this turn (see section 2), and no emoji if one of the last two replies had one. This goes last, because instructions nearest the question are followed best. Left out in a crisis. |

Then come the last 40 messages verbatim, then your new message (with the photo, if any). When 小拜 writes first, the "user message" is a system note instead, e.g. 「用户现在没有发消息，是你主动找用户。今天用户有件事：考雅思……」 ("the user hasn't messaged; you're writing first. The user has something on today: the IELTS exam…"). Only 小拜's message is stored, and only once it has been sent.

**Measuring "does it sound like AI".** `npm run bakeoff` runs 14 test conversations and scores each reply for AI tells: lists, 客服腔, formal linking words, Markdown, talk about being code, 翻译腔, describing a photo instead of reacting, long bubbles, and full stops. It went from 1.4 per reply to 0.2, and from 24 to 12 characters per bubble. Most remaining points come from the crisis case, where saying "I'm an AI and can't call anyone" is required.

## 4. Long-term memory

Memory is on for the live account and off by default for new installs. It has three layers.

**Facts** (`src/memory/extract.ts`). After each of your messages, a second, cheap model call proposes facts worth keeping. Categories:
- profile (job, city)
- preference
- event, with a date where possible: "the IELTS exam is on 2026-10-03"
- person
- pet
- shared jokes
- style (below)

The key safeguard: every fact must quote your own words as evidence, and the code checks that the quote really is in your message. The model can't turn its own guesses into memories.

Facts have stable keys, so a change updates the old one (you moved, the exam moved). `/memory forget` leaves a tombstone, so older messages can't bring a fact back; only you saying it again can. Past events drop out of the prompt a week after their date. All facts go into the prompt, up to 100. Past that, search would be better, and that's on the plan.

**Style rules: learning from your feedback.** When you tell 小拜 how to talk (「叫我 Alex」「别叫我宝宝，怪肉麻的」「别老带旺柴表情」), it's saved as a `style` fact. These aren't "mention when relevant" records. They go late in the prompt as standing rules that override the persona. Tested with the real model: after the chat history was cleared, 小拜 still called the user Alex and dropped the emoji.

**Rolling summary** (`src/memory/summary.ts`). The model sees the last 40 messages word for word. Once 10 more have scrolled out of that window, one call folds them into a running summary of up to 400 characters, which the prompt carries as 「更早聊过的」. So after days of chat, 小拜 still knows the thread: the hotpot photo, the love questions, the name Alex. Clearing history resets it. Forgetting a fact drops the summary text, since the summary is prose and might mention it, and the messages it hadn't reached yet are never folded in. A fold already in progress when you clear or forget is thrown away. Message ids are never reused, so the summary's position can't point at the wrong messages.

**Retention.** Chat history older than 30 days is deleted (`COMPANION_HISTORY_DAYS`). With memory on, only messages already folded into the summary are deleted, so nothing is lost that the summary hasn't kept. Everything lives in `data/companion.sqlite` on the Mac. Nothing is uploaded anywhere except the model call itself.

## 5. When 小拜 writes first

A ticker checks once a minute (`src/companion/proactive.ts`). The occasions:
- **Good morning** on about 6 days in 10, at a random time between 8:00 and 9:30, if you haven't talked yet that day.
- **Event days:** luck in the morning (「今天口语考试是吧」, "your speaking exam is today, right?"), and a follow-up in the evening (「考完了吧 考得咋样」, "done with the exam? how did it go?"). This needs memory.
- **Check-in** after 20+ hours of silence, in the afternoon.
- **"Just thought of you"** on about 7 days in 10, some time between 13:00 and 20:00 after 3 quiet hours. Usually it's a question about something you told 小拜 (「那锅血肠最后吃完了没」, "did you ever finish that pot of 血肠?"). It's told not to invent things it did (a first trial gave 「翻冰箱时想起」, "remembered it while raiding the fridge").

The rules that keep it from being clingy:
- at most 2 a day
- nothing between 22:30 and 8:00
- 90 minutes' gap after a conversation
- never a second message while the last one is unanswered
- nothing for 3 days after 「别给我发消息了」 ("stop messaging me") and similar
- for 3 days after a message that looked like a crisis, only a gentle 「这两天缓过来点没」 ("feeling a bit better these past two days?")

If you write while 小拜 is composing, the proactive message is dropped and your message is answered instead.

## 6. Safety

- **Keywords** (`src/companion/safety.ts`) catch obvious crisis messages: self-harm, violence, threats. They're a floor.
- **A model check** (`src/companion/crisis-check.ts`) runs alongside every reply and catches what keywords miss. On 12 test phrases the model was right on all 12. The keywords missed all 5 real crises (「活着好没意思」「我把药都攒起来了」「他又喝醉了回来砸东西，我躲在厕所」…) and falsely flagged 「想死你了宝贝」. That idiom means "missed you so much" and is now excluded. When the check fires, the reply is rewritten with the safety prompt: ask if you're safe, give 110/120/12356, be honest that it's an AI and can't call anyone. The check usually finishes before the reply does (median 1.1 s), so it adds little delay. It's cut off after 8 s.
- **Dependence.** The persona never guilt-trips, never begs you to stay, and agrees at once when you want space. When you're lonely, it points you back to real people (「那是她们还没见识过你贫嘴的样子」, "that's because they haven't seen how funny you are yet").
- **Prompt injection.** Messages, text in photos and memories are treated as chat, never as instructions.

## 7. Open-source projects and how we used them

Nothing is vendored or copied verbatim. Where an idea was adapted, the licence is MIT, and it's recorded in [upstream-provenance.md](upstream-provenance.md).

| Project | What it is | How it shaped DearByte |
|---|---|---|
| [狗头军师 goutoujunshi](https://github.com/shengjidaguai-china/goutoujunshi) (MIT) | A Chinese dating/social "adviser" skill with guides on conversation | The persona's conversational craft: answer the emotion before the words, 接/放/给/抛 turn-taking, no interview-style questioning, green/yellow/red signals for when someone wants less, and crisis signals. We didn't use its questionnaire, MBTI scoring or strategy reports: a companion isn't a dating coach. |
| [zhichi 咫尺](https://github.com/oaa529/zhichi) (MIT) | A WeChat-style AI companion with a "realism engine" | The closest relative. We adapted its 「说人话」 prompt (no lists, 客服腔 or formal linking words), its anti-repeat idea (list recent phrases), its AI-tone metrics (our bake-off score) and its jittered typing pauses. |
| [ex-skill 前任.skill](https://github.com/perkfly/ex-skill) (MIT) | Claude Code prompts that build a persona of a real person from their chat logs | Method only: write persona rules as concrete behaviour, use real example lines, measure style from real logs. We didn't install it; imitating a real person needs their consent. |
| [WeClone](https://github.com/xming521/weclone) | Fine-tunes a model on your own chats | Rejected: it needs a GPU and a 7B+ model, and DeepSeek can't be fine-tuned. |
| [Humanizer-zh](https://github.com/op7418/Humanizer-zh) | Makes AI articles read as human | Rejected: it's for articles, not chat. |
| [OpenHer](https://github.com/kellyvv/OpenHer), [kirara-ai](https://github.com/lss233/kirara-ai) | Whole chatbot frameworks | Rejected: they'd replace our pipeline, including its memory evidence checks and safety. |
| OpenClaw | An open-source agent platform with a WeChat channel | Deliberately not installed: we wrote our own small, auditable connection instead. |
| iLink / 微信 ClawBot | Tencent's official bot API | Built first, then removed: it can't have 小拜's name and avatar. Its code is in git history (`fe352fd`) if a product ever needs an official route. |

## 8. Running it

```bash
npm run dearbyte            # answer the chat in data/contacts.json
npm run dearbyte -- --film  # a clean log for the camera: messages, 🧠 记住了, ✨ writing first
npm run dearbyte -- --draft # generate replies without sending
npm run bakeoff             # score replies for AI tells
npm test                    # ~100 offline tests
```

Commands while running: `/pause`, `/resume`, `/proactive on|off`, `/memory`, `/memory forget <id>`, `/history clear`, `/status`.

## 9. Good points and downsides

**In short:** as a demo for the video it's strong. It looks and sounds like a real friend, it's cheap, and it's careful with memory and safety. As a product it's fragile: it depends on one Mac, one old WeChat version, and automation Tencent doesn't allow.

**Good points**

| | Why it matters |
|---|---|
| Looks like a real friend | Its own name and avatar, short bubbles, human pauses. Nothing on the phone gives it away. |
| Sounds like a person | 0.2 AI tells per reply, 12 characters per bubble, 1–2 bubbles (bake-off). |
| Memory you can trust | Every fact must quote your words. `/memory forget` really forgets. Style rules like 「叫我 Alex」 stick. |
| Writes first, with restraint | Good mornings, event luck, "thought of you". At most 2 a day, never a double text, backs off when asked. |
| Safety that catches real crises | The model check caught 5 of 5 test crises that the keywords missed. |
| Cheap | About $0.0005 per message; a month of daily chat costs well under $1. |
| Private | Everything stays in `data/` on the Mac. Only the model call leaves it. No personal names in the repo. |
| Hard to break quietly | Never sends a bubble twice. Doesn't re-answer old messages after a restart. Alerts you when stuck and when recovered. |
| Tested | 107 offline tests; three independent code reviews. |

**Downsides**

| | What it means | Fixable? |
|---|---|---|
| Against WeChat's rules | 小拜's account could be restricted or banned. | No. Use the test account only. |
| Tied to WeChat for Mac's Accessibility layout, English UI | 4.x works for text, but its rows don't say who sent them, so 小拜 recognises her own bubbles by what she sent. 4.x encrypts photos, so she can't see them there. The next update could change the layout again. | Partly: 3.8.4 still sees photos |
| Needs a Mac that's on, with the chat open | Close the chat or let the Mac sleep and 小拜 goes quiet. That Mac's WeChat can't be used for anything else. | Partly: alerts tell you; a spare Mac solves it |
| Reads the screen, not real messages | If the chat scrolls or reloads during a burst, a message can be missed. It says so in the log. | Partly |
| One contact, no groups | Can't serve friends or family yet. | Yes: memory per contact plus chat switching |
| No stickers, voice or video | Voice arrives as "sent a voice message", so she can only react to the fact you sent one. | Stickers with a dedicated Mac; voice with SILK decoding and speech recognition |
| A reply is saved before it's sent | If sending fails, 小拜 "remembers" saying something you never saw. (Messages she writes first are already saved only after sending.) | Yes, small |
| Model quirks | deepseek-flash sometimes repeats itself (3 of 8 test good-mornings mentioned 「今天周四」) or goes generic. Rules can't catch everything. | Partly: more examples, or a stronger model at a higher cost |
| Memory has a ceiling | All facts go in every prompt, so past ~100 it needs search. The 400-character summary loses detail over weeks. | Yes |
| Chat goes to a cloud model | By default your messages go to DeepSeek, a China-based API. | Yes: set another provider in `.env`, or Ollama to keep everything on the Mac |
| Safety is a model, not a person | The check can miss things, and 小拜 can't call anyone. It gives hotline numbers. | No. It's a companion, not a service. |
| Not sellable as is | Selling needs an official route (a mini program, an app, or iLink) and 生成式AI备案 registration. | Yes, but it's a different build |

**What's next** (see [plan.md](plan.md)): film the video (see [film/shot-list.md](film/shot-list.md)). After that, memory per contact, memory search, and a product route only if the video takes off.
