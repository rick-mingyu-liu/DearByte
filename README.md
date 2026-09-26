<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<h1 align="center">DearByte</h1>

<p align="center"><strong>A little attitude. A lot of care.</strong></p>

<p align="center">A self-hosted personal agent that knows how you slept, watches what you care about, and only spends within limits you approve.</p>

<p align="center">
<a href="https://github.com/dearbyte-labs/DearByte/stargazers"><img src="https://img.shields.io/github/stars/dearbyte-labs/DearByte?style=flat" alt="GitHub Stars"></a>
<img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental">
<img src="https://img.shields.io/badge/Node.js-26%2B-339933" alt="Node.js 26+">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

DearByte is a personal agent you run yourself. It:

- **Knows you.** Your Apple Watch health data, your calendar, and what you've asked it to remember.
- **Watches for you.** When your body and your schedule don't match, it says so ("you slept 5 hours and have leg day at 7; go light"). It also tells you about big news from the companies you follow within minutes, not weeks.
- **Spends for you, within limits.** It can propose buying a service. Code enforces the caps, and nothing is paid until you approve.

It's a friend and a coach, not an assistant reading a script, and never a romantic partner. It's not a doctor either: it talks about sleep, energy and pacing, and points you to a real one for anything medical.

## Why DearByte

Most AI assistants run on someone else's servers, and none of them know how you slept. DearByte is built around four choices:

- **Yours.** Self-hosted and open source. Your memory and logs live in a folder on your machine, and your health data goes through a Worker in your own Cloudflare account.
- **Body-aware.** Suggestions account for your sleep, recovery and schedule, measured against *your* normal, not a generic target.
- **Careful with money.** The agent can only propose purchases. Caps and allowlists are enforced in code, you approve every payment, and every payment gets a receipt.
- **Honest about cost.** Every model call is logged with its price, a weekly cap stops spending, and cheap models do the bulk work while a strong model makes the calls that matter.

## Status

DearByte is early and built in the open. What works today and what's coming:

| Part | Status |
| --- | --- |
| Agent core: tool loop, validated tools, Claude or DeepSeek as "brain" and "worker" tiers | **Works**, tested offline and with live DeepSeek runs; no real tools connected yet |
| Spending controls: per-run and weekly caps, a usage log of every model call | **Works** |
| English persona, plus the opt-in Chinese Xiaobai pack | **Works** |
| Chat companion in the terminal and in WeChat (Xiaobai, Chinese) with memory and proactive check-ins | **Works**, see [the companion](#the-chinese-companion-xiaobai) |
| Apple Watch and Apple Health data, through [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge) | **In progress** |
| Calendar awareness (Apple Calendar, via the same iPhone app) | Planned |
| Caution alerts and a morning brief that combine sleep, heart data and your schedule | Planned |
| Telegram for alerts and Approve/Reject buttons | Planned |
| Company watchlist: official newsroom feeds and SEC filings | Planned |
| Testnet wallet: the agent proposes a paid service, you approve, it pays within a cap, and you get a receipt | Planned |

## Roadmap

**Phase 1: the first demo** (target: 2026-09-28)
- [x] Agent core: tool loop, Claude/DeepSeek tiers, spending caps, usage log, English persona
- [ ] Apple Watch and Apple Health data through [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge), and `npm run agent` on real data
- [ ] Daily health snapshots, so DearByte learns your normal sleep, resting heart rate and HRV
- [ ] Caution alerts and a morning brief that combine your body and your calendar, with quiet hours and a daily limit
- [ ] Telegram for alerts, and Approve/Reject buttons
- [ ] Company watchlist: official newsroom feeds and SEC filings, with relevance filtered against what you care about
- [ ] Testnet wallet demo: the agent proposes a paid service, you approve, it pays in test USDC within a cap, and you get a receipt

**Phase 2: daily use, measured**
- Two weeks of real use with feedback on every alert; measure precision, missed events, delay and cost per month
- Calendar from the iPhone app (EventKit), an English app UI, and more news sources
- Approving purchases from the Apple Watch (needs a paid Apple Developer account)

**Later**
- A hosted DearByte for people who don't want to run it themselves
- A marketplace where solo developers and small companies sell useful services to agents, with DearByte as the first buyer. The agent, the bridge and the seller SDK stay open source.

## Quick start

Requires **Node.js 26+** (with nvm, run `nvm use` in the repo).

```bash
git clone https://github.com/dearbyte-labs/DearByte.git
cd DearByte
npm install
npm test
```

Create `.env` in the project root. It's ignored by Git:

```dotenv
DEEPSEEK_API_KEY=your_key
```

Run the agent once on sample data. This costs about $0.001:

```bash
npm run agent:smoke
npm run agent:usage
```

`agent:smoke` asks "How did I sleep, and should I still do leg day tonight?" against two sample tools and prints each step, the tool calls and the answer. `agent:usage` shows what that cost. The command-line agent on your real data (`npm run agent`) comes with the Apple Watch integration.

## Configuration

All settings go in `.env`.

| Setting | Default | What it does |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Key for DeepSeek, the default model for both tiers |
| `ANTHROPIC_API_KEY` | — | Key for Claude; needed when a tier uses `anthropic:` |
| `DEARBYTE_BRAIN` | `deepseek:deepseek-flash` | The model for judgment calls: caution alerts, news analysis, anything about money. For demos: `anthropic:claude-opus-5-5` |
| `DEARBYTE_BRAIN_EFFORT` | the model's default | `low` to `max`; set `high` for Claude Opus 5.5 |
| `DEARBYTE_WORKER` | `deepseek:deepseek-flash` | The model for high-volume, easy-to-check work: filtering, summaries |
| `DEARBYTE_PERSONA` | `default` | `default` (English DearByte) or `xiaobai` (Chinese) |
| `DEARBYTE_WEEKLY_CAP` | `5` | USD the agent may spend on model calls in any 7 days; `0` turns the cap off |

A model without a known price is refused, so the spending caps always work.

## How it works

```
you ─ CLI / Telegram ─┐
                      ▼
             agent loop ──── model tiers: brain (judgment) · worker (bulk)
                      │           │
                      │           └─ usage log + weekly cap
                      ▼
            validated tools ─┬─ health and sleep (dearbyte-bridge, MCP)
                             ├─ calendar
                             ├─ memory
                             ├─ company watchlist
                             └─ propose_purchase ──► your approval ──► payment code
```

- **Our own agent loop** (`src/agent/`): the model proposes tool calls, and every call is checked against a schema before it runs. Tool errors go back to the model instead of crashing the loop. No tools run after a refusal or a cut-off call, and each run stops at 8 steps or $0.50.
- **Any model, one interface:** Claude and DeepSeek both go through Anthropic's SDK (DeepSeek through its Anthropic-compatible endpoint). Claude-only features, such as adaptive thinking and refusal fallbacks, are sent only to Claude.
- **Approvals will live outside the model** (the design for the wallet, not built yet). The model can only propose a purchase. Payment code runs only when you approve, with caps and a seller allowlist checked in code.
- **Prompts stay cacheable:** the system prompt is identical on every request, and the current time goes into the message instead.

## Data and privacy

- **Your data stays on your machine** in the Git-ignored `data/` folder: memory, usage log, and chat history.
- **What leaves:** the context of each request goes to the model provider you choose (DeepSeek or Anthropic). Health data goes from your phone to *your own* Cloudflare Worker (dearbyte-bridge), and from there only to clients you give its secret MCP address to, such as DearByte.
- **Memory is inspectable and deletable,** and every stored fact quotes your own words as evidence.
- **Health:** DearByte uses summaries (last night's sleep, your 7-day average), not raw sample history. It isn't a medical device.

## Personas

`default` is DearByte in English: warm, a little cheeky, and never a partner. It gives US crisis resources (988, 911) if anyone is in danger. `xiaobai` is an opt-in Chinese persona with the tsundere 小拜 tone and China's crisis numbers. Both share the same rules: facts only from tools, missing data reported as unknown, and plain wording for anything involving money. The files are in `prompts/agent/`.

## The Chinese companion: Xiaobai

DearByte started as 小拜 (Xiaobai), a Chinese chat companion with its own personality. She has controllable memory and proactive check-ins, and runs in the terminal or, experimentally, through WeChat. That mode is unchanged:

```bash
npm run companion            # terminal chat
npm run companion -- --fake  # no model calls; replies labelled fake
```

The WeChat connection drives WeChat for Mac through macOS Accessibility. That isn't allowed by Tencent's terms and the account may be restricted, so use a test account, never your main one. Setup is in the [Chinese README](README.zh-CN.md) and the [operations guide](docs/guide.en.md).

## Documentation

| Document | Contents |
| --- | --- |
| [Operations guide](docs/guide.en.md) | Companion commands, proactive messaging, alerts, configuration, repository layout |
| [How it works](docs/how-it-works.md) | The companion's reply pipeline, memory and storage |
| [Roadmap](#roadmap) | What's next: the first demo, daily use, then hosting and the marketplace |
| [中文说明](README.zh-CN.md) | 小拜的中文介绍和快速开始 |
| [Contributing](CONTRIBUTING.md) | Read before opening a PR; report security issues through [SECURITY.md](SECURITY.md) |

## Contributing

```bash
npm test
npm run typecheck
```

Use [Issues](https://github.com/dearbyte-labs/DearByte/issues) to report problems or discuss ideas. Remove personal data, health data and API keys from reproductions.

## Acknowledgments

Health data comes from [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge), based on [apple-watch-health-mcp](https://github.com/ice-star-blue/apple-watch-health-mcp) (MIT). Xiaobai's conversation design draws on ideas from [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi), [咫尺](https://github.com/oaa529/zhichi) and [前任.skill](https://github.com/perkfly/ex-skill); see [upstream provenance](docs/upstream-provenance.md).

## License

[MIT](LICENSE). The upstream projects it draws on are MIT-licensed too.
