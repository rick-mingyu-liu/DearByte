# Making 小拜 sound less like an AI

**2026-09-24.** In the first live test, the replies read as AI-written. Examples from the log:

- 「在，刚被你这条消息从待机里捞出来」: a joke about being code, which the persona asked for.
- A photo got four ~30-character sentences that inventoried the picture and translated the sign on the table, like an image caption.
- Every reply arrived about a second after the message, with evenly spaced bubbles.

## What we looked at

| Project | Verdict |
|---|---|
| [zhichi 咫尺](https://github.com/oaa529/zhichi) (MIT, TypeScript) | Closest fit: a WeChat-style companion with a "realism engine". We adapted its 「说人话」 prompt, anti-repeat list, AI-tone metrics and typing jitter. |
| [ex-skill 前任.skill](https://github.com/perkfly/ex-skill) (MIT) | Claude Code prompts that build a persona of a real person from chat logs. Useful method: concrete behavioural rules, real example lines, style statistics. Not installed; copying a real person needs their consent. |
| [WeClone](https://github.com/xming521/weclone) | LoRA fine-tuning on your own chat history. Needs a GPU and a 7B+ model; DeepSeek can't be fine-tuned. Too heavy. |
| [Humanizer-zh](https://github.com/op7418/Humanizer-zh) and similar | For articles, not chat. |
| [OpenHer](https://github.com/kellyvv/OpenHer), [kirara-ai](https://github.com/lss233/kirara-ai) | Whole bot frameworks that would replace our pipeline. |

## What we changed

1. **Identity:** 小拜 no longer brings up being an AI or jokes about code. Asked sincerely, it says it's an AI in one line. It still never invents human experiences; asked 「吃了吗」, it turns the question back.
2. **Style rules with numbers:** most bubbles 3–15 characters, at most one over 25, one idea per bubble, fragments allowed, bubble count varies.
3. **「说人话」:** no lists, 客服腔, formal linking words or explained jokes.
4. **Photos:** react like a friend, point at one detail at most, don't read out or translate text in the picture.
5. **Examples rewritten** to be short, plus new ones for a photo with a caption, "are you human?" and "have you eaten?". Examples shape style more than rules.
6. **Anti-repeat:** the phrases 小拜 used in its last 3 turns go at the end of the prompt with "don't reuse these".
7. **Timing:** at least 1.5–3.5 s between message and first bubble (model time counts toward it), then ~150 ms per character between bubbles, with ±25% jitter.

8. **After live feedback (same day):** replies were still too long, and 「你爱我吗」 got a hedge (「爱这个字太重了，我可不敢乱认」). Now most replies are 1 bubble, at most 2 for small talk, and love/like questions get a clear, confident yes (「爱啊」「这还用问」), light and never clingy.
9. **Re-sent photos:** WeChat hard-links a photo sent twice to the old file, which keeps the old mtime. Photos now match by the later of mtime and ctime, with the thumbnail as a fallback.

## Measured (bake-off, 14 text cases × 2 runs, deepseek-flash)

| | AI-tone score per reply | Characters per bubble | Bubbles per reply |
|---|---|---|---|
| Before | 1.4 | 24.0 | 2.9 |
| After | 0.4 | 11.5 | 2.8 |
| After live feedback (fewer bubbles, clear yes to love/like) | 0.2–0.4 | 11.3 | 2.2 |

The remaining hits are the identity and crisis cases, where saying "我是 AI" is required. The two photo cases were skipped: they need real photos in `data/test-images/`.

## Next, if it still sounds off

- Photo cases: add real photos and check the photo replies.
- Learn style statistics from a real WeChat conversation exported with consent (ex-skill's method): message length, 语气词, punctuation and example lines, without copying the person.
