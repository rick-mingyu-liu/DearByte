// What the agent spent: the last 7 days by default, grouped by purpose, tier
// and model, against the weekly cap.
//
//   npm run agent:usage          # last 7 days
//   npm run agent:usage -- 30    # last 30 days

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/storage/store.ts";

const days = Number(process.argv[2] ?? 7);
if (!(days > 0)) throw new Error("days should be a positive number");
const config = loadConfig();
const store = Store.open(config.dbPath);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = store.agentUsageSummary(since);
const weekSpend = store.agentSpendSince(new Date(Date.now() - 7 * 86_400_000).toISOString());
store.close();

const n = (x: number) => x.toLocaleString("en-US");
console.log(`Agent usage, last ${days} days`);
if (!rows.length) console.log("  no calls");
for (const r of rows) {
  const hit = r.promptTokens ? Math.round((100 * r.cacheHitTokens) / r.promptTokens) : 0;
  const unpriced = r.unpriced ? ` (${r.unpriced} calls without a price)` : "";
  console.log(`  ${r.purpose} · ${r.tier} · ${r.model}: ${r.calls} calls · ${n(r.promptTokens)} in (${hit}% cached) · ${n(r.completionTokens)} out · $${r.cost.toFixed(4)}${unpriced}`);
}
const total = rows.reduce((sum, r) => sum + r.cost, 0);
console.log(`  total $${total.toFixed(4)}`);
console.log(
  config.agentWeeklyCap > 0
    ? `Weekly cap: $${weekSpend.toFixed(4)} of $${config.agentWeeklyCap} used in the last 7 days`
    : `Weekly cap: off ($${weekSpend.toFixed(4)} in the last 7 days)`,
);
