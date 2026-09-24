# Shot list: 「原来人真的会爱上代码」

**Format:** Douyin, vertical, under 30 s. The tone starts sincere and ends funny. Only hands and the phone are on camera, no face.

**The idea in one line:** a message that remembered your day arrives before you're up. It's sweet, then funny, and then the camera shows it came from a terminal.

Nothing in the chat is scripted. 小拜 writes every reply herself, so this list says how to **set up** each moment, not what she'll say. Every message on camera is a real one.

## The story (about 26 s)

| # | Time | Beat | On screen | What you do | What 小拜 needs |
|---|---|---|---|---|---|
| 1 | 0–4 s | **Hook**: someone thought of you first | The phone face-up on the bedside table, early light. The lock screen lights up: 「小拜：…面试…加油…」 | Nothing. A hand reaches in and picks it up. | A planted event dated today (see *Setup*). The morning nudge goes out soon after 8:30. |
| 2 | 4–10 s | **Sincere**: she remembered | The chat is open, her 1–2 bubbles about your interview. | Reply the way you really would, e.g. 「有点紧张」 | Nothing extra. She'll answer the nerves. |
| 3 | 10–17 s | **Care**: the soft reply | Her reply lands, no jokes, short. | Read it. Hold 2 s so viewers can read it too. | Nothing extra. |
| 4 | 17–23 s | **Funny turn** | You type 「你爱我吗」 | Send it. | Her rule is to answer this directly and warmly, often with a jab (「这还用问」, 「行了你，别拿这个试探我」). |
| 5 | 23–26 s | **Reveal** | Pull back or cut from the phone to the Mac: the terminal in `--film` shows 💬 你爱我吗 and 💌 her reply printing at the moment it lands on the phone. The title card 「原来人真的会爱上代码」 comes in. | Nothing. | The runner started with `--film`, on the Mac, in frame. |

On-screen captions (burned in, small):
- **Beat 1:** 「每天早上第一个找我的」 ("the first one to reach me every morning")
- **Beat 5:** 「……是我写的」 ("…is one I wrote"), then the title card

The caption hides "who" until the reveal. That gap is the twist.

## Setup (2–3 days before)

1. **Plant the event.** Chat normally with 小拜 and mention a real plan with its date, e.g. 「周五上午有个面试」 ("interview Friday morning"). Then check it was saved: `/memory` in the runner should list an `event` with that date. If it didn't save, mention it again another way.
   - Use a real thing (an interview, an exam, a doctor's visit, a flight). Her line will be better and the video stays honest.
2. **Chat normally on the days between.** It gives her real history, and makes the morning message feel like it's from someone who knows you.
3. **The night before, don't message her after about 7 a.m. on the day.** She won't write first within 90 minutes of the last message.
4. **Leave `/proactive on`.** It's on now.

## Shooting morning

- **Before 8:25:**
  - Mac awake, WeChat on 小拜's chat, runner started with `npm run dearbyte -- --film`.
  - Phone on the bedside table with notifications showing message previews.
  - Camera on a tripod, recording.
- **8:30–8:32:** the event message goes out on the first minute check after 8:30. (Events come before the plain good morning.) Keep recording until it lands.
- **Beats 2–5** right after, in one go. Film the phone over your shoulder and let the Mac terminal sit in the back of frame, or film the Mac separately at the same time with a second phone.
- **Screen-record the phone too** (iOS screen recording). It's the fallback for any bubble the camera can't read.

## If it doesn't go to plan

| Problem | What to do |
|---|---|
| No message by 8:35 | Check the runner log. 「已暂停」 (paused) or 「微信当前打开的是…」 (the wrong chat is open) mean the Mac side is off. Fix it and wait for tomorrow's nudge. Don't fake it. |
| Her line is flat | It's still real. Use it, or plant another event and shoot another day. Don't regenerate on camera. |
| Beat 4 reply is too long or too serious | Just ask again; a second 「你爱我吗」 usually gets a funnier answer. She remembers the retake, which is fine. That's how a person would react too. |
| A retake is needed for camera reasons only | Keep going in the same chat. Don't clear history between takes, or she loses the thread. |

## Backup ideas (if the main one fails)

- **The 3 p.m. goodnight.** Say 「晚安啦」 in the afternoon. She already answered 「下午两点半说晚安，你这是刚下夜班啊」 ("goodnight at 2:30 p.m.? just off the night shift?"). It's easy to get again and is a good funny beat.
- **The name.** 「叫我瑞克就行」 → 「行，瑞克 / 那之前叫你半天小乖，白叫了[白眼]」 ("ok 瑞克 / so all that 小乖 was wasted [eye-roll]"). A cute first-meeting beat for a longer cut.
- **The lonely line.** 「可现实中没女生跟我这样聊天」 ("no girl in real life talks to me like this"). The most sincere beat we have. It's better for a longer video than for the 30 s cut.

## Privacy check before posting

- Crop out the Mac's menu bar, other chats in WeChat's list, and your real account name.
- `--film` labels your messages with the **first** name in `data/contacts.json` (now 「Rick」). Put the name you want on camera first. The WeChat chat title shows too (「张三」). Rename the chat's remark to something you're happy to show, and add the new name to `data/contacts.json` and restart the runner first so 小拜 keeps replying.
