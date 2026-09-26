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

DearByte is early and built in the open. All of Phase 1 is on `master` (248 offline tests). What works today and what's coming:

| Part | Status |
| --- | --- |
| Agent core: tool loop, validated tools, Claude or DeepSeek as "brain" and "worker" tiers | **Works**, tested offline and with live DeepSeek runs |
| Spending controls: per-run and weekly caps, a usage log of every model call | **Works** |
| English persona, plus the opt-in Chinese Xiaobai pack | **Works** |
| Chat companion in the terminal and in WeChat (Xiaobai, Chinese) with memory and proactive check-ins | **Works**, see [the companion](#the-chinese-companion-xiaobai) |
| Apple Watch and Apple Health data, through [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge) | **Works** with the bridge's test data; a live test with a real iPhone is next |
| Calendar awareness (Apple Calendar, via the same iPhone app) | Planned |
| Caution alerts and a morning brief, judged against your own normal sleep, resting heart rate and HRV | **Works**; the calendar part waits for calendar awareness |
| Telegram for alerts, a 👍/👎 on every alert, and Approve/Reject buttons | **Works** in tests; a live test with a real bot is next |
| Company watchlist: official newsroom feeds and SEC filings, screened against what you care about | **Works**, tested live on real feeds |
| Testnet wallet: the agent proposes a paid service, you approve, it pays within a cap, and you get a receipt | **Works** with x402 on Base Sepolia, tested live against the example seller in dev mode; an on-chain payment needs test USDC from the faucet |

## Roadmap

**Phase 1: the first demo** (target: 2026-09-28)
- [x] Agent core: tool loop, Claude/DeepSeek tiers, spending caps, usage log, English persona
- [x] Apple Watch and Apple Health data through [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge), and `npm run agent`
- [x] Daily health snapshots, so DearByte learns your normal sleep, resting heart rate and HRV
- [x] Caution alerts and a morning brief, with quiet hours and a daily limit (calendar comes in Phase 2)
- [x] Telegram for alerts, and Approve/Reject buttons
- [x] Company watchlist: official newsroom feeds and SEC filings, with relevance filtered against what you care about
- [x] Testnet wallet demo: the agent proposes a paid service, you approve, it pays in test USDC within a cap, and you get a receipt

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

`agent:smoke` asks "How did I sleep, and should I still do leg day tonight?" against two sample tools and prints each step, the tool calls and the answer. `agent:usage` shows what that cost.

Then use the agent itself (`npm run agent` lists every command):

```bash
npm run agent -- status     # which models, tools and limits are active
npm run agent -- chat       # talk to it; tools appear as you set them up
npm run agent -- watch      # always on: morning brief, caution alerts, news
```

The [agent guide](docs/agent-guide.md) walks through setting up health, Telegram, the watchlist and the wallet in order, and has a checklist for testing each one live.

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
| `HEALTH_MCP_URL` | — | Your dearbyte-bridge MCP address. It contains a secret, so treat it like a password |
| `TELEGRAM_BOT_TOKEN` | — | Your bot's token from @BotFather. Secret: whoever has it controls the bot |
| `SEC_CONTACT_EMAIL` | — | SEC asks automated clients for a contact email; without it the watchlist reads newsrooms only |
| `DEARBYTE_WATCHLIST` | `watchlist.json` | Where your watchlist is |
| `DEARBYTE_WALLET_KEY` | — | The testnet wallet's key; `npm run agent -- wallet new` creates it and writes it here |
| `DEARBYTE_SELLERS` | — | Comma-separated seller addresses the wallet may buy from, like `http://127.0.0.1:4021` |
| `DEARBYTE_MAX_PURCHASE` | `0.25` | USD limit per purchase |
| `DEARBYTE_MAX_DAY` | `1` | USD limit per day |
| `TELEGRAM_CHAT_ID` | — | Your chat with the bot; `npm run agent -- telegram` finds it. Only this chat can use the buttons |

A model without a known price is refused, so the spending caps always work.

### Company watchlist

Copy `watchlist.example.json` to `watchlist.json` (ignored by Git) and edit it. `interests` says, in your words, what's worth a message; each company has its newsroom feeds and, optionally, its SEC number (`cik`).

```bash
npm run agent -- news    # check once; `watch` checks every hour
```

Only official sources are read: each company's newsroom feed and its SEC filings (8-K, 10-Q, 10-K and similar; not insider trades). Each check:
1. Stores what's new, deduped by source id. Anything already 2 days old when first seen is recorded but never screened.
2. The worker model screens new items against your `interests` and records a verdict and a reason for each, through a validated tool call.
3. The brain writes one short message about what passed. The links are appended by code from the stored items, not written by the model.

News follows the same quiet hours as health, with at most 3 news messages a day. The agent can also answer "anything new on Meta?" from what was collected (`get_company_news`).

### Testnet wallet

DearByte can buy things for you from sellers you approve, over [x402](https://www.x402.org) (HTTP 402 "Payment Required", paid in USDC). Phase 1 is **testnet only**: Base Sepolia and test USDC, never real money.

```bash
npm run agent -- wallet new          # creates a key, writes it to .env, prints the address
# get free test USDC at https://faucet.circle.com (network: Base Sepolia)
npm run seller -- --dev              # an example seller on http://127.0.0.1:4021
DEARBYTE_SELLERS=http://127.0.0.1:4021 npm run agent -- chat
```

1. **You ask, it proposes.** For example: "I slept 5 hours; get me the recovery plan at http://127.0.0.1:4021/recovery-plan." The model can only call `propose_purchase`. Code then:
   - asks the seller its price (the 402 answer);
   - checks the seller allowlist and the per-purchase and daily caps;
   - sends you an approval request.
2. **You approve** with the button in Telegram, `/approve N` in chat, or `npm run agent -- approve N`. You always see the request as code wrote it (price, seller, recipient first), and in the terminal you confirm with "yes". At most 3 requests wait at once, and each expires after 15 minutes.
3. **It pays, and you get a receipt.** Code asks for a fresh quote and refuses if the recipient changed or the price went up. It then reserves the amount against the daily limit, signs a transfer for exactly the approved amount (valid for at most 5 minutes), gets the resource, and keeps the receipt with its transaction link. If a signed payment goes out but no transaction comes back, the receipt says "unconfirmed" and the amount still counts toward the limit. `npm run agent -- wallet` shows the balance, limits and recent purchases.

The example seller's `--dev` mode checks the signature without touching the chain, so you can demo the whole flow before the faucet. Without `--dev` (and with `SELLER_PAY_TO` set), payments settle on Base Sepolia through the x402.org facilitator. The seller moves to its own repo as the start of the seller SDK.

### Telegram

Terminal first; Telegram is where DearByte reaches you when you're away from it. It sends briefs and alerts, each with 👍 Useful / 👎 Not useful buttons (the ratings show up in `npm run agent -- status`, so alert precision is measured, not guessed), and anything that needs your yes comes with ✅ Approve / ❌ Reject.

1. Message @BotFather in Telegram, send `/newbot`, and put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Send your bot any message, then run `npm run agent -- telegram`. It prints your chat id; add it as `TELEGRAM_CHAT_ID`.
3. Run `npm run agent -- telegram` again. It sends a test approval; tap a button to check it works.

Button taps are handled while `npm run agent -- watch` runs. Approval requests expire after 15 minutes, each is decided once, and messages or taps from any other chat are ignored.

## How it works

```
you ─ CLI / Telegram ─┐
                      ▼
             agent loop ──── model tiers: brain (judgment) · worker (bulk)
                      │           │
                      │           └─ usage log + weekly cap
                      ▼
            validated tools ─┬─ health and sleep (dearbyte-bridge, MCP)
                             ├─ calendar (Phase 2)
                             ├─ memory
                             ├─ company watchlist
                             └─ propose_purchase ──► your approval ──► payment code
```

- **Our own agent loop** (`src/agent/`): the model proposes tool calls, and every call is checked against a schema before it runs. Tool errors go back to the model instead of crashing the loop. No tools run after a refusal or a cut-off call, and each run stops at 8 steps or $0.50.
- **Any model, one interface:** Claude and DeepSeek both go through Anthropic's SDK (DeepSeek through its Anthropic-compatible endpoint). Claude-only features, such as adaptive thinking and refusal fallbacks, are sent only to Claude.
- **Approvals live outside the model.** The model can only propose a purchase. Payment code runs only when you approve (in Telegram or the terminal), with caps and a seller allowlist checked in code, and each approval is decided once.
- **Prompts stay cacheable:** the system prompt is identical on every request, and the current time goes into the message instead.

## Data and privacy

- **Your data stays on your machine** in the Git-ignored `data/` folder: memory, chat history, the usage log, daily health summaries, alerts and your ratings, news items, approvals and purchase receipts.
- **What leaves:** the context of each request goes to the model provider you choose (DeepSeek or Anthropic). Health data goes from your phone to *your own* Cloudflare Worker (dearbyte-bridge), and from there only to clients you give its secret MCP address to, such as DearByte. Briefs, alerts and approval requests you get in Telegram go through Telegram's servers. The watchlist only reads public newsroom feeds and SEC filings.
- **The wallet key** stays in `.env` and is only used to sign payments you approved; it's never sent anywhere or printed.
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
| [Agent guide](docs/agent-guide.md) | Setting up health, Telegram, the watchlist and the wallet; every command; a live test checklist |
| [Operations guide](docs/guide.en.md) | 小拜 companion: commands, proactive messaging, WeChat, configuration, repository layout |
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
