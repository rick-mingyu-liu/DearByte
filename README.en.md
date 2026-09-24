<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<h1 align="center">DearByte · 小拜</h1>

<p align="center"><strong>A little attitude. A lot of care.</strong></p>

<p align="center">Meet Xiaobai, an AI companion with a personality of her own.<br>She remembers the little things, sometimes checks in first, and gives you space when you need it.</p>

<p align="center">
<a href="https://github.com/rick-mingyu-liu/DearByte/stargazers"><img src="https://img.shields.io/github/stars/rick-mingyu-liu/DearByte?style=flat" alt="GitHub Stars"></a>
<img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental">
<img src="https://img.shields.io/badge/Node.js-26%2B-339933" alt="Node.js 26+">
</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="docs/guide.en.md">User guide</a> · <a href="#data-and-privacy">Data and privacy</a> · <a href="#contributing">Contributing</a></p>

Xiaobai is a little cheeky and quietly attentive. She can trade jokes or listen when you've had a rough day. With memory enabled, she can remember preferences and plans you've mentioned, so your next conversation can pick up where you left off.

DearByte is an AI companion prototype that runs in your terminal, with an experimental WeChat connection. Documentation is available in Simplified Chinese and English; **the current persona and conversation design are primarily in Chinese**.

If this sounds like your kind of companion, leave a ⭐ Star and follow Xiaobai's progress.

## What you can do together

| The experience | What Xiaobai can do today |
| --- | --- |
| Unwind with a quick chat | Reply in short, expressive messages, with multiple bubbles and paced delivery |
| Skip repeating your backstory | With memory enabled, retain facts grounded in your own words and summarize older conversations |
| Have an important day remembered | With memory and proactive messages enabled, check in on remembered events such as exams or interviews |
| Share a photo from your day | Discuss images; WeChat mode needs an additional local image-folder setting |
| Receive an occasional hello | Send morning greetings, check-ins and spontaneous messages, with frequency limits and quiet hours |
| Take some time to yourself | Disable proactive messages, or ask for space to pause them for three days |
| Choose what stays | Inspect, delete or export memories, or disable long-term memory; it is off by default |

## Quick start

Requires **Node.js 26+** (with nvm, run `nvm use` in the repo). Meet Xiaobai in your terminal first:

```bash
git clone https://github.com/rick-mingyu-liu/DearByte.git
cd DearByte
npm install
```

Create `.env` in the project root with your API key. This file is ignored by Git:

```dotenv
DEEPSEEK_API_KEY=your_API_key
```

OpenAI, Claude, Gemini, Qwen, Kimi, GLM, OpenRouter and local Ollama work too; see [Configuration](docs/guide.en.md#configuration-env). Each reply costs at most $1 by default.

```bash
npm run companion
```

Without a key, run `npm run companion -- --fake` to check the local flow. This mode makes no model calls and labels its replies as fake.

| Command | Action |
| --- | --- |
| `/memory on` / `/memory off` | Enable or disable long-term memory |
| `/memory` | Inspect memories |
| `/memory forget <id>` | Delete one memory |
| `/memory export` | Export memories |
| `/img <path> [caption]` | Send a local image |
| `/history clear` | Clear chat history while keeping memories |
| `/help` / `/quit` | Show help / exit |

### Chat in WeChat

The WeChat connection uses macOS Accessibility to operate the desktop client. It currently targets **WeChat for Mac 4.x (or 3.8.4), with the English UI and a single one-to-one chat**. On 4.x, photos need the Screen Recording permission. Accessibility permission and Swift are required; photos need a separate folder setting.

This is an experimental demo route with a risk of account restrictions. Use a test account. See the [English user guide](docs/guide.en.md) for setup, draft mode, and pause/resume controls.

#### Set the contact allowlist

In Mac WeChat, signed in as Xiaobai, open the one-to-one chat you want her to answer. Use the full name shown at the top of the chat, not the person's WeChat ID:

```bash
npm run dearbyte -- --chat "Alex Zhang" --draft
```

On first run, the runner checks the open chat's name and creates `data/contacts.json`. Draft mode generates replies without sending them. After checking the setup, quit and start automatic replies:

```bash
npm run dearbyte
```

If that same contact has different remarks or nicknames, edit `data/contacts.json` and add the possible display names to `names`:

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

Replace the example names with actual display names for **the same person**; leave `id` as `me`. Save and restart the runner. Once the file exists, `--chat` does not append or overwrite the allowlist: edit the file directly.

**Only one contact is currently supported.** Do not list different people as aliases or add a second contact object; history and memory are not isolated per contact yet. This file is ignored by Git. See the [contact setup guide](docs/guide.en.md#set-the-allowed-contact) for more details.

## Data and privacy

- **Long-term memory is off by default.** When enabled, memories can be inspected, deleted or exported. Chat history is separate: disabling memory does not stop history storage.
- **Local storage, cloud generation.** History, memories, summaries and settings live in the Git-ignored `data/` directory. Relevant conversation context is sent to the model provider you configure (DeepSeek by default) to generate replies; photos are used only for the current turn.
- **History is retained for 30 days by default.** With memory enabled, older messages are summarized before deletion. Clearing history does not also clear memories.
- **Tencent still carries WeChat messages.** Deleting local data does not delete messages already sent in WeChat or data the model provider may retain.

## Current status

Terminal chat, controllable memory, image input, proactive messages and the experimental WeChat connection are implemented. WeChat text and photo flows were tested on a real device on **2026-09-24**.

WeChat mode currently supports one contact. Voice messages, videos, files and stickers cannot be understood directly. Xiaobai is an AI, not a person; crisis-signal detection adjusts replies but cannot replace professional help or contact emergency services.

## Contributing

```bash
npm test
npm run typecheck
```

Use [Issues](https://github.com/rick-mingyu-liu/DearByte/issues) to report problems or discuss ideas, or submit improvements. Remove personal chat details and API keys from reproductions.

| Documentation | Contents |
| --- | --- |
| [Chinese user guide](docs/guide.zh-CN.md) | Setup, WeChat, common configuration and controls |
| [Full operations guide](docs/guide.en.md) | All commands, proactive messaging rules, alerts, configuration and repository layout |
| [How it works](docs/how-it-works.md) | Reply generation, memory and storage |
| [Project plan](docs/plan.md) | Decisions, progress and milestones |
| [Improvements](docs/improvements.md) | Areas for future work |
| [Contributing](CONTRIBUTING.md) | Read before opening a PR; report security issues via [SECURITY.md](SECURITY.md) |

## Acknowledgments

Xiaobai's conversation design draws on ideas from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi), [咫尺](https://github.com/oaa529/zhichi), and [前任.skill](https://github.com/perkfly/ex-skill). See [upstream provenance](docs/upstream-provenance.md) for sources, adaptations and differences.
