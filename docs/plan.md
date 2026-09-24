# DearByte plan

**Last updated:** 2026-09-24. This replaces the original Codex proposal (`docs/superpowers/plans/dearbyte.md`, deleted; its last version is in commit `fe352fd`).

## What we're building

小拜 is a Chinese-speaking AI companion (嘴贫但细心) that you chat with in **your own WeChat**, with a terminal beside it showing what happens on each turn. The first goal is a Douyin video for 「原来人真的会爱上代码」:

1. A phone sends a photo of a cat with 「刚刚回来路上看见的，你看看这是什么」.
2. 小拜 answers in 2–4 short bubbles grounded in the photo.
3. The terminal shows the message arriving, the model call, the cost and the memory changes.

A possible second goal is selling it. That depends on questions below that aren't settled yet.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| WeChat connection | **Our own iLink client**, the official API behind 微信 ClawBot, **without OpenClaw** | Official and documented terms, real photo bytes, no second account, no Mac left running WeChat. OpenClaw would bring a general-purpose agent with shell and file access and would take over the conversation. The Tencent client is only an OpenClaw plugin, so we re-implemented the few calls we need. |
| Desktop automation (original plan) | Fallback only | Not authorised. Tencent has sued makers of automation tools. It is fragile, and photos aren't exposed. |
| Model | DeepSeek `deepseek-flash` | Cheapest option that can read images: about $0.0003–0.0008 per reply, with 1–4 s latency. The code talks to it through a small provider interface, so it can be replaced. |
| Architecture | A fixed pipeline, **not an agent** | The model has no tools. Code decides what is stored and sent, which is safer and easier to predict. |
| Storage | SQLite (`node:sqlite`) in a local `data/` folder | One file with no server and no native dependencies. It's enough for one user. A hosted product would move to Postgres. |
| Memory | Short facts, each kept only if its evidence is a **verbatim quote** of the user | The model's guesses never become "memories". Facts can be listed, deleted and exported. Memory is off by default. |
| Persona | Adapted from 狗头军师 (MIT): 接 / 放 / 给 / 抛, emotion first, teasing limits | 小拜 is open about being code and never invents human experiences. |
| Safety | Crisis keywords add a safety prompt (110 / 120 / 12356) | Keyword matching is a floor, not a full classifier (see Milestone 3). |

## Where it stands

Done and committed on `demo-core`:

- **Terminal simulator:** `npm run companion`, with photos (including HEIC), memory commands and per-turn cost logs.
- **Persona, examples and safety prompt,** plus the bake-off tool (`npm run bakeoff`) for testing the persona against real cases.
- **WeChat runner:** `npm run dearbyte`. It covers:
  - QR login, answering only the person who scanned
  - photos and voice (using WeChat's own transcript)
  - bursts of messages merged into one turn
  - typing indicator and bubble-by-bubble sending
  - clean shutdown, and running without a terminal
- **Tests and review:** 52 offline tests; an independent review found no critical or high issues, and its medium findings are fixed.

**Not yet verified:** a real login and chat. Everything WeChat-side has only been tested against fakes.

## Milestone 1: live WeChat check (next, needs your phone)

Start with `npm run dearbyte -- --fake` (no model cost), then run it for real. Check each of these:

- [ ] The QR login works and **微信 ClawBot** appears; set its remark (备注) to "小拜".
- [ ] A text message gets a reply.
- [ ] A multi-bubble reply arrives as separate bubbles, which confirms one `context_token` can be used for several sends.
- [ ] A photo is recognised correctly.
- [ ] A voice message is answered from its transcript.
- [ ] Three quick messages get one reply.
- [ ] A restart doesn't re-answer old messages, and memory survives it.
- [ ] Record timings: time to first bubble and gaps between bubbles.
- [ ] Record whether a reply still works after the chat has been idle for an hour or more (`context_token` lifetime).

Record the results in `docs/design/wechat-transport.md`.

## Milestone 2: ready to film

- [ ] Put real photos in `data/test-images/` (`cat.jpg`, `food.jpg`) and run `npm run bakeoff`. Tune the persona until photo replies feel natural.
- [ ] Add a clean "filming" log mode: short, readable Chinese lines with no token counts. Keep the detailed mode for development.
- [ ] Rehearse the scene: turn memory on a few days before filming, so continuity (「你上次说的那只猫」) appears naturally rather than being staged.
- [ ] Decide how to show the contact on camera. The name and avatar can't be changed (see below). Either frame the shot on the chat content, or show the remark "小拜" and accept the default avatar.

## Milestone 3: quality

- [ ] **Rolling summary:** today the prompt gets the last 40 messages verbatim. Add a short running summary so longer relationships stay coherent without prompt costs growing.
- [ ] **Forgetting:** `/memory forget` should also remove the fact from recent history sent to the model, not only from the fact table.
- [ ] **Memory claims:** 小拜 sometimes says 「我都记着」 when memory is off. Tighten the persona and add a bake-off case.
- [ ] **Crisis detection:** add a cheap model-based check next to the keywords. Keep the keywords as a fallback.
- [ ] **History retention:** make it configurable, disclose it, and default to 30 days.

## Milestone 4: only if selling

This milestone has a gate: don't build until both questions are answered.

1. **iLink terms:** community write-ups describe ClawBot as for personal use and 「不适用于商业客服」. Read the full 《微信 ClawBot 功能使用条款》 and ask Tencent if needed. If a commercial product isn't allowed, the WeChat route doesn't work for selling.
2. **China regulation:** 《人工智能拟人化互动服务管理暂行办法》 has applied since 2026-07-15. A public service needs:
   - disclosure that it is an AI, with a reminder after every 2 hours of continuous use
   - no design that encourages dependence
   - protection for minors: age checks, no virtual romance, parental consent under 14
   - a way for users to copy and delete their history, and to leave immediately
   - a security assessment and 算法备案 before launch

If both answers allow it, there are two ways to sell:

- **(a) Sell it as software:** each buyer runs it on their own computer with their own API key and scans their own QR code. Data stays with them, so there's no server and no multi-tenancy. This is the lightest option, but buyers need some technical skill.
- **(b) Hosted service:** needs Postgres, per-user accounts and tokens, billing, the full compliance list, and PIPL data-handling duties, because we would be processing everyone's chats.

**Recommendation:** use the video to test demand first. If people ask for it, start with (a).

## Things iLink can't do

- **Change the bot's name or avatar:** the contact is always 「微信 ClawBot」 with the default avatar. The user can set a remark (备注), which only changes it on their own phone.
- **Read or change the user's profile:** the bot only sees an opaque `ilink_user_id`, not the user's WeChat name, avatar or contacts.
- **Start a conversation:** 小拜 can only reply, so good-morning messages and reminders aren't possible.
- **Join group chats.**

The whole protocol is nine endpoints: login (2), receive, send, typing (2), media upload, and start/stop notices. None of them touches profiles.

## Risks

| Risk | What we do |
|---|---|
| Tencent changes the iLink protocol | Our client is small and mirrors plugin 2.4.9. Check the official plugin's changelog before each filming session. |
| iLink is discontinued, or the token is revoked | The simulator still works. Desktop automation is the fallback, with its account risk. |
| The model says something harmful or invents a memory | Persona rules, the safety prompt, verbatim-evidence memory and bake-off tests. |
| Private data: chats pass through Tencent and DeepSeek | Everything local is in `data/` (gitignored). The README says what leaves the machine. |

## Deferred

Proactive messages, sending images or stickers, voice replies, group chat, a web UI, fine-tuning, local models and multiple users. Most are out of reach with iLink anyway.
