import { expect, test } from "vitest";
import { BudgetedModel, BudgetExceeded, withTurnBudget } from "../src/model/budget.ts";
import { FakeModel } from "../src/model/fake.ts";
import { costAt, ModelHttpError, type Prices } from "../src/model/provider.ts";

// Expensive on purpose: $10 in / $100 out per 1M tokens, so small calls add up.
const prices: Prices = { input: 10, cached: 10, output: 100 };

/** A model that bills `out` output tokens for every call. */
function billing(out: number) {
  const inner = new FakeModel(Array.from({ length: 20 }, () => "{}"));
  const complete = inner.complete.bind(inner);
  inner.complete = async (m, o) => ({ ...(await complete(m, o)), usage: { promptTokens: 100, cacheHitTokens: 0, completionTokens: out } });
  inner.cost = (u) => costAt(prices, u);
  return inner;
}

const msg = [{ role: "user" as const, content: "你好" }];

test("calls share one budget within a reply, and stop once it runs out", async () => {
  const inner = billing(2_000); // $0.201 per call
  const model = new BudgetedModel(inner, prices, 1);
  await withTurnBudget(async () => {
    for (let i = 0; i < 4; i++) await model.complete(msg, { json: true, maxTokens: 2_000 });
    // $0.804 spent: about 1,950 output tokens are left, so the cap shrinks.
    await model.complete(msg, { json: true, maxTokens: 2_000 });
    expect(inner.calls.at(-1)!.opts.maxTokens).toBeLessThan(2_000);
    await expect(model.complete(msg, { json: true, maxTokens: 2_000 })).rejects.toBeInstanceOf(BudgetExceeded);
  });
  expect(inner.calls).toHaveLength(5);
});

test("calls in flight at the same time can't overspend together", async () => {
  const inner = billing(4_000);
  const model = new BudgetedModel(inner, prices, 1);
  await withTurnBudget(async () => {
    await Promise.allSettled([4_000, 4_000, 4_000].map((maxTokens) => model.complete(msg, { json: true, maxTokens })));
    const granted = inner.calls.reduce((n, c) => n + c.opts.maxTokens!, 0);
    expect((granted * prices.output) / 1e6).toBeLessThanOrEqual(1);
    expect(inner.calls.at(-1)!.opts.maxTokens).toBeLessThan(4_000); // the third had to fit in what was left
  });
});

test("each reply gets a fresh budget, and background work stays on its reply's tab", async () => {
  const inner = billing(2_000);
  const model = new BudgetedModel(inner, prices, 0.5);
  let later: Promise<unknown> = Promise.resolve();
  await withTurnBudget(async () => {
    await model.complete(msg, { json: true, maxTokens: 2_000 });
    await model.complete(msg, { json: true, maxTokens: 2_000 });
    // Like the memory step: started in the reply, finished after it returned.
    later = new Promise((r) => setTimeout(r, 5)).then(() => model.complete(msg, { json: true, maxTokens: 2_000 }));
  });
  await later;
  expect(inner.calls[2].opts.maxTokens).toBeLessThan(2_000); // charged to the same reply
  await withTurnBudget(() => model.complete(msg, { json: true, maxTokens: 2_000 }));
  expect(inner.calls[3].opts.maxTokens).toBe(2_000); // a new reply starts fresh
});

test("a cap of 0 turns it off; outside a reply each call is its own budget", async () => {
  const offInner = billing(50_000);
  const off = new BudgetedModel(offInner, prices, 0);
  await withTurnBudget(async () => {
    for (let i = 0; i < 3; i++) await off.complete(msg, { json: true, maxTokens: 50_000 });
  });
  expect(offInner.calls.map((c) => c.opts.maxTokens)).toEqual([50_000, 50_000, 50_000]); // $5 each, never stopped
  const onInner = billing(2_000);
  const on = new BudgetedModel(onInner, prices, 0.3);
  for (let i = 0; i < 3; i++) await on.complete(msg, { json: true, maxTokens: 2_000 });
  expect(onInner.calls.map((c) => c.opts.maxTokens)).toEqual([2_000, 2_000, 2_000]);
});

test("a call with no usage reported is charged its worst case, not $0", async () => {
  const inner = billing(0);
  const complete = inner.complete.bind(inner);
  inner.complete = async (m, o) => {
    const c = await complete(m, o);
    return { ...c, usage: { ...c.usage, unreported: true } };
  };
  const model = new BudgetedModel(inner, prices, 1);
  await withTurnBudget(async () => {
    await model.complete(msg, { json: true, maxTokens: 5_000 }); // reserves about $0.50
    await expect(model.complete(msg, { json: true, maxTokens: 5_000 })).resolves.toBeDefined(); // shrunk to fit
    await expect(model.complete(msg, { json: true, maxTokens: 5_000 })).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

test("a failed call is charged unless the provider refused it with a 4xx", async () => {
  const failing = (err: Error) => {
    const inner = billing(0);
    inner.complete = async () => {
      throw err;
    };
    return new BudgetedModel(inner, prices, 1);
  };
  const timeout = failing(new Error("The operation was aborted due to timeout"));
  await withTurnBudget(async () => {
    await expect(timeout.complete(msg, { json: true, maxTokens: 5_000 })).rejects.toThrow("timeout");
    await expect(timeout.complete(msg, { json: true, maxTokens: 5_000 })).rejects.toThrow("timeout");
    await expect(timeout.complete(msg, { json: true, maxTokens: 5_000 })).rejects.toBeInstanceOf(BudgetExceeded);
  });
  const refused = failing(new ModelHttpError("HTTP 401", 401));
  await withTurnBudget(async () => {
    for (let i = 0; i < 5; i++) await expect(refused.complete(msg, { json: true, maxTokens: 5_000 })).rejects.toBeInstanceOf(ModelHttpError);
  });
});

test("a call too big for the whole budget is refused before it's made", async () => {
  const inner = billing(10);
  const model = new BudgetedModel(inner, prices, 0.01);
  const huge = [{ role: "user" as const, content: "字".repeat(2_000) }]; // ~$0.02 of input alone
  await expect(model.complete(huge, { json: true })).rejects.toBeInstanceOf(BudgetExceeded);
  expect(inner.calls).toHaveLength(0);
});
