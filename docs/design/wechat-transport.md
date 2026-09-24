# WeChat transport: iLink (official) vs. desktop automation

**Decision (2026-09-24): build the demo on iLink, Tencent's official personal-account bot API. Keep desktop Accessibility automation as a fallback only.**

This reverses the original Codex proposal (replaced by [the plan](../plan.md)), which dropped iLink because it "does not attach to the current desktop chat". The demo doesn't need that: it only needs a WeChat chat on the phone.

## What iLink is

- Tencent released it on 2026-03-22 as the transport behind the **微信 ClawBot** plugin, covered by 《微信 ClawBot 功能使用条款》. The official client is [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT).
- **Setup:** you scan a QR code with WeChat and get a `bot_token`. The bot then appears in *your own* WeChat as a contact.
- **API:** plain HTTP/JSON at `ilinkai.weixin.qq.com`:
  - `getupdates`: long-poll for new messages
  - `sendmessage`: reply
  - `sendtyping`: show "typing"
  - `getuploadurl`: CDN upload for outgoing media
- **Media:** text, image, voice, file and video, in both directions. Media sits on a CDN, encrypted with AES-128-ECB; the client decrypts it.
- **Replies only:** every reply carries the `context_token` from an incoming message. The bot cannot start a conversation.

## Comparison for this project

| | iLink | Desktop Accessibility |
|---|---|---|
| Tencent's position | Official, with published terms | Unauthorised automation; account risk; Tencent has sued makers of automation tools |
| Photos | **Real image bytes** (decrypted from the CDN) | Not exposed; would need copy-image or screen capture |
| Message identity | Real message IDs and a cursor | Invented from the UI; fragile |
| Sending | API call with a clear result | UI scripting with focus and composer races |
| Accounts needed | **Just yours.** The bot is a contact in your account. | A second test account plus a Mac left logged in |
| Runs on | Anything that can make HTTPS calls | Only the Mac with WeChat open |
| Sellable later | Plausible; see open questions | No |
| On camera | Contact is called "微信 ClawBot" with the default avatar | Looks like a normal friend |
| Proactive messages | No | Yes (not in scope anyway) |

The on-camera difference is the only real cost. There's no API to rename the bot or change its avatar. You can set a **remark (备注)** such as "小拜" on your phone, which changes the chat title you see; the avatar stays the default.

## Implementation (2026-09-24)

`src/channels/ilink/` is our own client, written without OpenClaw; `npm run dearbyte` runs it. Why we skip OpenClaw: the official client runs only as an OpenClaw plugin. It imports OpenClaw's plugin SDK in 12 files, and OpenClaw would then run the conversation. Using it would mean installing a general-purpose agent with shell and file access, and rewriting our persona, memory and safety pipeline for that agent.

What the reference code settled:
- **Multi-bubble replies:** the plugin sends several messages with the same `context_token` for one reply, so bubbles go out as separate messages.
- **Voice:** voice messages carry WeChat's own transcript (`voice_item.text`).

Not verified yet: a real login, how long a `context_token` stays valid, and rate limits.

## Open questions to confirm when connecting

1. **Multi-bubble replies:** the official client reuses one `context_token` for several sends, so this should work. Confirm it live, and check how long the token stays valid.
2. **Rate and frequency limits:** the terms let Tencent limit "信息收发规模或频率". Measure what normal use looks like.
3. **Calling the protocol directly:** the official package is an OpenClaw plugin. Calling the same endpoints directly (as the plugin does, and as several community projects do) is not documented as a supported standalone use.
4. **Commercial or multi-user use:** community write-ups describe it as for personal use and "不适用于商业客服". Read the full terms before building anything to sell.
5. **Data responsibility:** under the terms, Tencent only relays messages. We, as the third-party AI service, process the user's content and are responsible for it, which matters under PIPL (China's personal-information law).

## Sources

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
- [iLink protocol walkthrough (x1ah/wechat-ilink-demo)](https://github.com/x1ah/wechat-ilink-demo)
- [What is iLink (allclaw.org)](https://allclaw.org/blog/what-is-ilink)
- [WeChat developer community: renaming the ClawBot](https://developers.weixin.qq.com/community/develop/doc/0004489fe006c0c47725b0ef06b800)
- [Tencent Cloud developer article on the ClawBot terms](https://cloud.tencent.com/developer/article/2646635)
- [Qiniu: what ClawBot can and cannot do](https://news.qiniu.com/archives/1774342011600)
- [SCMP launch coverage](https://www.scmp.com/tech/article/3347590/tencent-adds-clawbot-plug-wechat-amid-openclaw-boom-and-privacy-warnings)
