# WeChat transport: desktop automation of a real 小拜 account

**Decision (2026-09-24, revised the same day): 小拜 is a real WeChat account with its own name and avatar. WeChat for Mac, logged in as 小拜, is driven through macOS Accessibility.** The iLink client was built and then removed (its last version is in commit `fe352fd`).

## Why not iLink (微信 ClawBot)

iLink is Tencent's official personal-account bot API, and technically the better transport: official terms, real message IDs, real photo bytes. But the bot always appears as **「微信 ClawBot」 with the default avatar**. No API renames it or changes its avatar; a remark (备注) changes only what the viewer's own phone shows. The video needs 小拜 to look like a real friend in the chat list, so we went back to the test account created for this.

| | Desktop (chosen) | iLink (removed) |
|---|---|---|
| On camera | **Its own name and avatar**, like any friend | 「微信 ClawBot」, default avatar |
| Tencent's position | Unauthorised automation; account risk | Official, with published terms |
| Accounts needed | A second account (小拜) plus a Mac left logged in | Just yours |
| Photos | Unencrypted JPEGs in WeChat's local folder (3.8.4 only) | Downloaded and decrypted from the CDN |
| Message identity | Inferred from the UI's rows | Real IDs and a cursor |
| Sellable | No | Maybe; the terms suggest personal use only |

## How it works

`native/wechat-desktop/main.swift` is a small helper that talks JSON lines over stdin/stdout. `src/channels/desktop/` polls it twice a second.

- **Finding the window:** `kAXMainWindowAttribute` of `com.tencent.xinWeChat`. This works while WeChat is on another Space, where `AXWindows` is empty.
- **Reading:** the messages are an `AXTable` described as "Messages"; each row's cell children carry an `AXTitle`.
- **Sending:** the composer is an `AXTextArea` titled with the chat name. The helper checks the bound chat is open and the composer is empty, sets `AXValue`, checks again, then posts Return with `CGEvent.postToPid`. That works without bringing WeChat to the front. It then waits up to 6 s for a new `MeSaid:<text>` row.
  - Failures before Return (wrong chat, someone's draft) are retried a few times.
  - A bubble that isn't confirmed is reported and **never resent**, so nothing is sent twice.
- **New messages:** each snapshot is compared with the previous one. The alignment tolerates rows dropping off the top and a row changing in place while it loads; if the two don't line up at all, the runner resyncs and may miss a message. The first snapshot is only a baseline.
- **Photos:** WeChat 3.8.4 saves each received image as `…/<account>/Message/MessageTemp/<chat>/Image/<id>_.pic.jpg` (plus `_.pic_thumb.jpg`). When a photo row appears, the runner claims the oldest new full-size file in the configured folder, waiting up to 15 s. Only that one folder is read.

## What we observed (WeChat 3.8.4, English UI)

Row titles:

| Row | Meaning |
|---|---|
| `AlexSaid:在吗` | Text from the contact. The name is the contact's **nickname**, not the chat title (which here is the remark 「张三」). |
| `Alex:Sent aPhoto` | Photo from the contact |
| `MeSaid:…` | Sent by 小拜 |
| `01:34`, `Yesterday 23:51` | Time labels |

- Repeated identical messages appear as separate rows.
- The received photo checked was a 1280×1707 JPEG, unencrypted.
- Live test on 2026-09-24:
  - Text reply: 1.2 s of model time, about $0.0001.
  - A photo with a caption merged into one turn and was described correctly: 3.6 s, about $0.0008, 4 bubbles.
  - The first run missed messages because rows were matched on the chat title; that is fixed and covered by tests.

## WeChat 4.x (observed on 4.1.13, 2026-09-24)

WeChat for Mac updated itself to 4.1.13 and 小拜 stopped reading the chat: the helper looked for 3.8.4's "Messages" table.

- **Controls have identifiers now.** The message list is `chat_message_list` (an `AXList`) and the composer is `chat_input_field` (its title is the chat name). The helper finds these first and falls back to 3.8.4's layout.
- **Rows carry only the text.** Message rows are `AXStaticText` with identifier `chat_bubble_item_view` and the bubble's text as title, with no sender. Time labels have no identifier. Rows scrolled out of view stay in the list as empty `virtual_cell`s, and new rows are appended at the bottom, so positions stay stable. The helper passes messages as `Bubble:<text>`, time labels as they are, and off-screen rows as "".
- **Who sent it.** The channel remembers what 小拜 sent in the last 10 minutes; a bubble matching one of those (ignoring spaces and emoji codes like `[白眼]`) is hers. The rest are the user's.
- **A received photo reads `Image`.** 4.x stores images encrypted, and we don't decrypt WeChat's files. Instead the helper captures WeChat's own window with ScreenCaptureKit (no other window, no cursor), 1.5 s after the row appears so the blurred preview has sharpened, and crops it to the newest photo row. 小拜 sees the chat's preview (about 600 px on a Retina screen), which was enough in the first live test. It needs the Screen Recording permission for the terminal; without it, 小拜 says she can't see the photo. Before any of this, the row reached the model as the text "Image" and it made up a picture.
- **Two runners answer each other.** On the first 4.x test two runners were live; each took the other's bubbles for the user's and they replied to each other every few seconds. The runner now holds `data/runner.lock`, and it pauses itself after more than 6 turns in a minute.
- **Lost on 4.x:** telling a group chat apart, and messages typed as 小拜 on the phone (they'd be read as the user's). A user message identical to something 小拜 said in the last 10 minutes is ignored.

## Limits and risks

- **Account risk:** Tencent doesn't authorise automation. Use only the test account. Keep the volume human: one chat, replies only.
- **Version:** 4.x (tested on 4.1.13) and 3.8.4, English UI. Rows were only observed in English, and 4.x encrypts image files.
- **The Mac must stay awake** with the chat open, scrolled to the bottom. Scrolling up or switching chats pauses replies until it's back.
- **One-to-one only:** any sender who isn't "Me" is treated as the user. Group chats would need the sender kept.
- **Not a product:** this route can't be sold. Selling would need a different transport (see the plan).

## Stickers and pictures (probed 2026-09-24)

小拜 can't send pictures or stickers while WeChat sits in the background:

- **Pasting into the composer:** pasting an image (as a file link or as PNG data) with ⌘V sent through `postToPid` does nothing. WeChat's Edit → Paste menu item is disabled while WeChat isn't the active app.
- **The Stickers button:** it exists in the chat toolbar (`AXButton` titled "Stickers"), but the panel it opens isn't exposed through Accessibility while WeChat is on another Space.

**WeChat's own sticker packs** (downloaded from the sticker store) are the stickers we want. They are encrypted on disk (`Stickers/Persistence`, and `stickers.db` is not plain SQLite), and we won't try to decrypt them. The panel does open on a real click with WeChat in front, but its contents aren't exposed to Accessibility. A screenshot from the operator shows what's in it:

- **Layout:** a grid of 5 per row, each sticker with a text label, plus tabs along the bottom: search, emoji, favourites, then one tab per downloaded pack.
- **Labels in the first pack:** 早安, 早早, 得意, 超得意, 送你fafa, 想宝宝, 收到, ok, 摸摸头, 可怜巴巴.

**Plan for later (dedicated Mac only, behind a `--stickers` flag):**
1. List the pack labels in a config file, by tab and grid position.
2. 小拜 picks a label, the same way it picks emojis.
3. The helper brings WeChat to the front and clicks the Stickers button.
4. It finds the panel's frame with `CGWindowListCopyWindowInfo`; bounds need no Screen Recording permission.
5. It clicks the pack tab and the cell, confirms a new "Me" row, and switches back.

It breaks if the pack order or panel layout changes.

In general, sending stickers means bringing WeChat to the front for a moment: activate it, paste, press Return, then switch back. That takes focus from whoever is using the Mac, and switches Spaces if WeChat is on another one. Not built yet.

**Emojis:** Unicode emojis are plain text and work. WeChat's own codes such as `[捂脸]` are sent as text from the English UI and render as pictures on the phone (confirmed 2026-09-24).

**Decision (2026-09-24): emojis only for now.** Stickers can't be sent in the background on a Mac someone is using. If they're wanted later, WeChat needs a screen of its own where it can stay in front: a spare Mac, or a macOS VM (UTM/Tart; WeChat 3.8.4 in a VM is untested).

## Typing status (probed 2026-09-24)

The phone shows 「对方正在输入…」 ("the other party is typing…") while a friend types. We tested whether 小拜 can show it while the model is writing. The test never pressed Return. The operator watched the chat on the phone:

- **Filling the message box directly** (the way sending works), holding the text for 10 s: nothing on the phone.
- **Real key events, one character every 0.7 s**, to WeChat in the background: the text arrived in the box, but nothing showed on the phone.

WeChat for Mac 3.8.4 doesn't send typing status from the background, at least. It might from the foreground, but 小拜 has to work in the background, so we stopped there. (iLink has a typing call, but that route was dropped for the name and avatar.) The human feel comes from the reading and typing pauses between bubbles instead.
