# DearByte plan

**Last updated:** 2026-09-24. This replaces the original Codex proposal (`docs/superpowers/plans/dearbyte.md`, deleted; its last version is in commit `fe352fd`).

## What we're building

小拜 is a Chinese-speaking AI companion (嘴贫但细心) with **its own WeChat account, name and avatar**. You chat with it from your phone like any friend, with a terminal beside it showing what happens on each turn. The first goal is a Douyin video for 「原来人真的会爱上代码」:

1. A phone sends a photo of a cat with 「刚刚回来路上看见的，你看看这是什么」.
2. 小拜 answers in 2–4 short bubbles grounded in the photo.
3. The terminal shows the message arriving, the model call, the cost and the memory changes.

A possible second goal is selling it. That depends on questions below that aren't settled yet.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| WeChat connection | **Desktop automation of a real 小拜 account**: WeChat for Mac 3.8.4, driven through macOS Accessibility by a small Swift helper | The video needs 小拜's own name and avatar. iLink (微信 ClawBot) was built first and removed, because the bot is always 「微信 ClawBot」 with the default avatar. The cost: automation isn't authorised, so the test account is at risk, and this route can't be sold. See [the transport notes](design/wechat-transport.md). |
| Model | DeepSeek `deepseek-flash` | Cheapest option that can read images: about $0.0003–0.0008 per reply, with 1–4 s latency. The code talks to it through a small provider interface, so it can be replaced. |
| Architecture | A fixed pipeline, **not an agent** | The model has no tools. Code decides what is stored and sent, which is safer and easier to predict. |
| Storage | SQLite (`node:sqlite`) in a local `data/` folder | One file with no server and no native dependencies. It's enough for one user. A hosted product would move to Postgres. |
| Memory | Short facts, each kept only if its evidence is a **verbatim quote** of the user | The model's guesses never become "memories". Facts can be listed, deleted and exported. Memory is off by default. |
| Persona | Adapted from 狗头军师 (MIT): 接 / 放 / 给 / 抛, emotion first, teasing limits | 小拜 chats like a friend and never invents human experiences. It doesn't bring up being an AI, but says so honestly when sincerely asked. |
| Safety | Crisis keywords add a safety prompt (110 / 120 / 12356) | Keyword matching is a floor, not a full classifier (see Milestone 3). |

## Where it stands

Done and committed on `demo-core`:

- **Terminal simulator:** `npm run companion`, with photos (including HEIC), memory commands and per-turn cost logs.
- **Persona, examples and safety prompt,** plus the bake-off tool (`npm run bakeoff`) for testing the persona against real cases.
- **WeChat runner:** `npm run dearbyte`, on the real 小拜 account. It covers:
  - binding one chat and never answering what was already in it
  - photos read from WeChat's local image folder
  - bursts of messages merged into one turn
  - bubble-by-bubble sending, confirmed in the chat and never resent
  - `--draft` mode, `/pause` and `/resume`, clean shutdown, and running without a terminal
- **Tests:** 46 offline tests.

## Milestone 1: live WeChat check (in progress)

- [x] A text message gets a multi-bubble reply (2026-09-24, 1.2 s model time).
- [x] A photo with a caption is merged into one turn and recognised correctly (3.6 s).
- [x] Several quick messages get one reply.
- [ ] A restart doesn't re-answer old messages, and memory survives it.
- [ ] Stickers and voice get an honest "I can't see/hear that" reply.
- [ ] 小拜 keeps working for an hour or more with the Mac idle (screen lock, sleep settings).
- [ ] Record end-to-end timings from the phone: time to first bubble and gaps between bubbles.

Record the results in `docs/design/wechat-transport.md`.

## Milestone 2: ready to film

- [ ] Put real photos in `data/test-images/` (`cat.jpg`, `food.jpg`) and run `npm run bakeoff`. Tune the persona until photo replies feel natural.
- [x] Add a clean "filming" log mode (`--film`, 2026-09-24): the conversation, 小拜 writing first, and 「🧠 记住了」 lines; no token counts.
- [x] Alerts when 小拜 goes quiet (macOS notification, optional ntfy push), and keep the Mac awake while running (2026-09-24).
- [ ] Rehearse the scene: turn memory on a few days before filming, so continuity (「你上次说的那只猫」) appears naturally rather than being staged.
- [ ] Set 小拜's avatar, nickname and signature on the test account, and make sure your phone shows 小拜 (not an old remark) in the chat list.
- [ ] Before each filming session, check WeChat for Mac is still 3.8.4 and hasn't auto-updated.

## Milestone 3: quality

- [x] **Less AI-sounding replies** (2026-09-24): identity rules, 「说人话」, short bubbles, photo reactions, anti-repeat, human timing, and an AI-tone score in the bake-off. See [the design note](design/humanlike-replies.md).
- [ ] Check photo replies with real test photos, and consider learning style from a consented real chat export.
- [ ] **Stickers from WeChat's own packs** on a dedicated Mac: click the sticker panel by grid position (plan in [the transport notes](design/wechat-transport.md#stickers-and-pictures-probed-2026-09-24)).
- [x] **Proactive messages** (2026-09-24): good mornings, event luck and follow-ups, check-ins after a silence; at most 2 a day, never at night, never double-texting (`src/companion/proactive.ts`).
- [ ] **Memory search:** once facts pass about 100, retrieve the relevant ones (SQLite FTS5 over facts and old messages) instead of putting all of them in the prompt.
- [x] **Rolling summary** (2026-09-24): messages leaving the 40-message window are folded, 10 at a time, into a summary of up to 400 characters kept in the prompt (`src/memory/summary.ts`). `/history clear` resets it; forgetting a fact drops its text.
- [x] **Learning from feedback** (2026-09-24): requests about how 小拜 talks become `style` memories, used as standing rules.
- [ ] **Forgetting:** `/memory forget` should also remove the fact from recent history sent to the model, not only from the fact table.
- [ ] **Memory claims:** 小拜 sometimes says 「我都记着」 when memory is off. Tighten the persona and add a bake-off case.
- [ ] **Crisis detection:** add a cheap model-based check next to the keywords. Keep the keywords as a fallback.
- [x] **History retention** (2026-09-24): `COMPANION_HISTORY_DAYS`, default 30; with memory on, only messages already in the summary are deleted. Disclosed in the README.

## Milestone 4: only if selling

This milestone has a gate: don't build until both questions are answered.

1. **A sellable transport:** desktop automation can't be sold. The candidates are iLink (微信 ClawBot; community write-ups describe it as for personal use and 「不适用于商业客服」, so read the full 《微信 ClawBot 功能使用条款》), 企业微信, or a 公众号 / 服务号. Each has its own terms and look on the phone. If none allows it, the product has to live outside WeChat.
2. **China regulation:** 《人工智能拟人化互动服务管理暂行办法》 has applied since 2026-07-15. A public service needs:
   - disclosure that it is an AI, with a reminder after every 2 hours of continuous use
   - no design that encourages dependence (小拜 now answers "do you love me?" with a clear yes, by choice for the demo; a public product must revisit this)
   - protection for minors: age checks, no virtual romance, parental consent under 14
   - a way for users to copy and delete their history, and to leave immediately
   - a security assessment and 算法备案 before launch

If both answers allow it, there are two ways to sell:

- **(a) Sell it as software:** each buyer runs it on their own computer with their own API key and connects their own WeChat through the permitted transport. Data stays with them, so there's no server and no multi-tenancy. This is the lightest option, but buyers need some technical skill.
- **(b) Hosted service:** needs Postgres, per-user accounts and tokens, billing, the full compliance list, and PIPL data-handling duties, because we would be processing everyone's chats.

**Recommendation:** use the video to test demand first. If people ask for it, start with (a).

## Risks

| Risk | What we do |
|---|---|
| The 小拜 test account is restricted for automation | Keep the volume human (one chat, replies only). The simulator still works for filming the terminal side. iLink (commit `fe352fd`) is the fallback, with the ClawBot name and avatar. |
| WeChat for Mac updates or the UI changes | Stay on 3.8.4 with the English UI; the row parser is small and tested. |
| The model says something harmful or invents a memory | Persona rules, the safety prompt, verbatim-evidence memory and bake-off tests. |
| Private data: chats pass through Tencent and DeepSeek | Everything local is in `data/` (gitignored). The README says what leaves the machine. |

## Deferred

Proactive messages (possible on this route, but not wanted for the demo), sending images or stickers, voice replies, group chat, a web UI, fine-tuning, local models and multiple users.
