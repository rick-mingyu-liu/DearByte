[README](../README.md) · [How the companion works](how-it-works.md)

# DearByte agent — Setup and testing guide

This guide covers the personal agent: health, caution alerts and the morning brief, Telegram, the company watchlist and the testnet wallet. For 小拜, the Chinese companion, see the [operations guide](guide.en.md).

**Status (2026-09-26):** all of Phase 1 is on `master`, and 248 offline tests pass. Watchlist screening has been run live against real feeds with DeepSeek. The wallet's full flow (proposal, approval, receipt) has been run live against the example seller in `--dev` mode. Still to test live: your own Apple Watch data, a real Telegram bot, an on-chain testnet payment, and Claude as the brain. The [checklist](#live-test-checklist) below covers each one.

## Setup, in order

Each step works without the ones after it. Run `npm run agent -- status` at any point to see which models, tools and limits are active.

| Step | What you do | Result |
| --- | --- | --- |
| 1. Models | `DEEPSEEK_API_KEY` in `.env` (optionally `ANTHROPIC_API_KEY` and `DEARBYTE_BRAIN=anthropic:claude-opus-5-5`) | `ask` and `chat` work |
| 2. Health | Install the [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge) iPhone app and Worker; put the MCP address in `HEALTH_MCP_URL` | Sleep, heart rate and HRV tools; the brief and caution alerts |
| 3. Telegram | Create a bot with @BotFather; see [Telegram](../README.md#telegram) | Alerts and approvals reach you away from the terminal |
| 4. Watchlist | Copy `watchlist.example.json` to `watchlist.json`; optionally set `SEC_CONTACT_EMAIL` | Company news, screened against your interests |
| 5. Wallet | `npm run agent -- wallet new`, then test USDC from [Circle's faucet](https://faucet.circle.com) (Base Sepolia); set `DEARBYTE_SELLERS` | The agent can propose purchases, and you approve them |

Secrets (`HEALTH_MCP_URL`, `TELEGRAM_BOT_TOKEN`, `DEARBYTE_WALLET_KEY`, API keys) go only in `.env`, which Git ignores. Never paste them into chat, issues, commits or screenshots. `wallet new` prints only the address, never the key.

## Commands

```bash
npm run agent -- ask "How did I sleep?"   # answer one question
npm run agent -- chat                     # talk until /quit; /approve N works here
npm run agent -- status                   # models, tools, limits, spending, alert ratings
npm run agent -- brief [--force]          # send the morning brief now
npm run agent -- check                    # run the caution rules once
npm run agent -- watch                    # keep running (see below)
npm run agent -- alerts                   # recent briefs and alerts
npm run agent -- telegram                 # set up Telegram, or send a test approval
npm run agent -- news                     # check the company watchlist once
npm run agent -- wallet [new]             # address, balance, limits, recent purchases
npm run agent -- approvals                # requests waiting for your yes
npm run agent -- approve N | reject N     # answer one in the terminal
npm run seller [-- --dev]                 # the example x402 seller on http://127.0.0.1:4021
npm run agent:usage                       # what every model call cost
```

`watch` is DearByte's always-on mode. While it runs:
- the morning brief goes out after 07:30;
- the caution rules run every 15 minutes, and the watchlist is checked every hour;
- Telegram button taps (👍/👎, Approve/Reject) are handled.

Nothing is sent in quiet hours (23:00–07:00). DearByte sends at most 3 caution alerts and at most 3 news messages a day, and model spending counts toward `DEARBYTE_WEEKLY_CAP`. Run only one `watch` at a time: two would each answer taps and send alerts.

## Where things are stored

Everything is in `data/companion.sqlite` (Git-ignored):

| Table | What |
| --- | --- |
| `health_daily` | One summary per day (sleep, resting heart rate, HRV), used for your 14-day baseline |
| `agent_alerts` | Every brief and alert DearByte sent on its own, with your 👍/👎 |
| `approvals` | Approval requests: pending, approved, rejected or expired |
| `watch_items` | News items seen, with the model's verdict and whether they were sent |
| `purchases` | Wallet receipts: paid, unconfirmed or failed, with the transaction link |
| `agent_usage` | Every model call with its tokens and price |

## Live test checklist

Run these once each part is set up. Each should take a few minutes.

**Health (needs `HEALTH_MCP_URL`)**
- [ ] `npm run agent -- ask "How did I sleep last night?"` gives numbers that match the Health app.
- [ ] `npm run agent -- brief --force` writes a brief that compares last night with your normal. Until a few nights are stored, sleep is compared with a default 7 hours.
- [ ] `npm run agent -- check` either sends nothing or gives a reason you agree with.

**Telegram (needs the bot token and chat id)**
- [ ] `npm run agent -- telegram` sends a test approval, and tapping a button answers it.
- [ ] With `watch` running, `brief --force` arrives in Telegram with 👍/👎, and the tap shows up in `status`.
- [ ] A message from another Telegram account to the bot is ignored.

**Watchlist (needs `watchlist.json`)**
- [ ] `npm run agent -- news` lists what it found and why each item was kept or skipped.
- [ ] Running it again right away sends nothing new.
- [ ] In `chat`, "anything new on Meta?" answers from what was collected, with links.

**Wallet on testnet (needs faucet USDC)**
- [ ] `npm run agent -- wallet` shows the address and a USDC balance.
- [ ] Start the seller for real: `SELLER_PAY_TO=<a second address you control> npm run seller`.
- [ ] In `chat` (with `DEARBYTE_SELLERS=http://127.0.0.1:4021`), ask for the recovery plan. Approve it, and check that the receipt says **paid** and links a Base Sepolia transaction.
- [ ] Ask for something over `DEARBYTE_MAX_PURCHASE`. It should be refused, with nothing proposed.
- [ ] Reject a proposal. Nothing should be paid.

**Claude as the brain (optional, needs `ANTHROPIC_API_KEY`)**
- [ ] `DEARBYTE_BRAIN=anthropic:claude-opus-5-5 npm run agent -- brief --force` works, and its cost shows in `npm run agent:usage`.

## Code layout

```text
src/agent-cli.ts        the npm run agent commands
src/agent/              agent loop, validated tools, model tiers, usage log, approvals, scheduled brief and alerts
src/health/             bridge MCP client, daily snapshots and baseline, caution rules
src/telegram/           Bot API client (long polling) and the handler for button taps
src/watchlist/          newsroom and SEC sources, screening, news tools
src/wallet/             limits, x402 quote and payment, purchase proposals and receipts
examples/seller/        example x402 seller (moving to its own repo)
prompts/agent/          personas
```
