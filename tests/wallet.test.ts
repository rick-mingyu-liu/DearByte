import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { decide } from "../src/agent/approvals.ts";
import { Store } from "../src/storage/store.ts";
import { formatUsd, NETWORK, resolveWallet, toUnits, USDC, type WalletConfig } from "../src/wallet/config.ts";
import { proposePurchase, purchaseHandler, walletTools, type WalletDeps } from "../src/wallet/purchase.ts";
import { pay, quote, termsOf } from "../src/wallet/x402.ts";

const NOW = new Date("2026-09-26T10:00:00-04:00");
const SELLER = "http://127.0.0.1:4021";
const PAY_TO = "0x1111111111111111111111111111111111111111";

/** A fake x402 seller: 402 with a price, then the resource for a payment that signs for exactly that price. */
function seller(o: { price?: string; network?: string; asset?: string; payTo?: () => string; settle?: boolean } = {}) {
  const paid: Array<{ from: string; to: string; value: string }> = [];
  let quotes = 0;
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const offer = { scheme: "exact", network: o.network ?? NETWORK, asset: o.asset ?? USDC, amount: o.price ?? "50000", payTo: o.payTo?.() ?? PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
    const required = { x402Version: 2, resource: { url, description: "A recovery plan", mimeType: "application/json" }, accepts: [offer] } as PaymentRequired;
    const signature = headers.get("payment-signature");
    if (!signature) {
      quotes++;
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } });
    }
    const payload = decodePaymentSignatureHeader(signature);
    const auth = (payload.payload as { authorization: { from: string; to: string; value: string } }).authorization;
    paid.push(auth);
    const settle = { success: o.settle ?? true, transaction: "0xabc123", network: NETWORK, errorReason: o.settle === false ? "insufficient_funds" : undefined };
    return new Response(JSON.stringify({ plan: ["sleep early"] }), { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, paid, quotes: () => quotes };
}

const key = generatePrivateKey();
const walletConfig = (over: Partial<WalletConfig> = {}): WalletConfig => ({
  key,
  address: privateKeyToAccount(key).address,
  sellers: [SELLER],
  maxPerPurchase: 250_000n,
  maxPerDay: 1_000_000n,
  ...over,
});

function deps(o: { fetch: typeof fetch; wallet?: Partial<WalletConfig>; store?: Store }) {
  const store = o.store ?? Store.open(":memory:");
  const sent: number[] = [];
  const d: WalletDeps = { wallet: walletConfig(o.wallet), store, timeZone: "America/Toronto", fetch: o.fetch, now: () => NOW, sendApproval: async (a) => (sent.push(a.id), true) };
  return { d, store, sent, handlers: { purchase: purchaseHandler(d) } };
}

test("amounts: dollars to USDC units and back", () => {
  expect(toUnits("0.05")).toBe(50_000n);
  expect(toUnits("1")).toBe(1_000_000n);
  expect(toUnits("0.0000001")).toBeNull();
  expect(toUnits("-1")).toBeNull();
  expect(formatUsd(50_000n)).toBe("$0.05");
  expect(formatUsd(1_250_000n)).toBe("$1.25");
  expect(formatUsd(1n)).toBe("$0.000001");
});

test("config: a key, allowed sellers by origin, and caps", () => {
  expect(resolveWallet({})).toBeNull();
  expect(resolveWallet({ DEARBYTE_WALLET_KEY: "0x12" })).toHaveProperty("problem");
  const w = resolveWallet({ DEARBYTE_WALLET_KEY: key, DEARBYTE_SELLERS: "http://127.0.0.1:4021/recovery-plan, https://seller.example.com", DEARBYTE_MAX_PURCHASE: "0.1" });
  expect(w).toMatchObject({ address: privateKeyToAccount(key).address, sellers: [SELLER, "https://seller.example.com"], maxPerPurchase: 100_000n, maxPerDay: 1_000_000n });
  expect(resolveWallet({ DEARBYTE_WALLET_KEY: key, DEARBYTE_SELLERS: "ftp://x" })).toHaveProperty("problem");
});

test("x402: quote reads the price; pay signs for exactly the approved terms", async () => {
  const s = seller();
  const q = await quote(`${SELLER}/recovery-plan`, s.fetch);
  expect(q).toMatchObject({ description: "A recovery plan", accept: { amount: "50000", payTo: PAY_TO } });
  const paid = await pay(termsOf(`${SELLER}/recovery-plan`, q), key, s.fetch);
  expect(paid).toMatchObject({ tx: "0xabc123", status: 200 });
  expect(JSON.parse(paid.result)).toEqual({ plan: ["sleep early"] });
  expect(s.paid).toEqual([{ from: privateKeyToAccount(key).address, to: PAY_TO, value: "50000", validAfter: expect.any(String), validBefore: expect.any(String), nonce: expect.any(String) }]);
});

test("x402: mainnet or another token is refused before anything is signed", async () => {
  await expect(quote(`${SELLER}/x`, seller({ network: "eip155:8453" }).fetch)).rejects.toThrow("doesn't accept test USDC on Base Sepolia");
  await expect(quote(`${SELLER}/x`, seller({ asset: "0x2222222222222222222222222222222222222222" }).fetch)).rejects.toThrow("doesn't accept test USDC");
});

test("x402: a seller that changes the recipient or raises the price after approval isn't paid", async () => {
  let recipient = PAY_TO;
  const s = seller({ payTo: () => recipient });
  const terms = termsOf(`${SELLER}/p`, await quote(`${SELLER}/p`, s.fetch));
  recipient = "0x3333333333333333333333333333333333333333";
  await expect(pay(terms, key, s.fetch)).rejects.toThrow("changed who gets paid");
  const pricier = seller({ price: "60000" });
  await expect(pay({ ...terms, payTo: PAY_TO, amount: "50000" }, key, pricier.fetch)).rejects.toThrow("raised the price");
  expect([...s.paid, ...pricier.paid]).toEqual([]);
});

test("purchase: proposed, approved, paid once, with a receipt", async () => {
  const s = seller();
  const { d, store, sent, handlers } = deps({ fetch: s.fetch });
  const told = await proposePurchase(d, { url: `${SELLER}/recovery-plan`, reason: "You slept 5h10m." });
  expect(told).toContain('Proposed purchase #1 for $0.05 (the seller describes it as: "A recovery plan")');
  expect(told).toContain("Don't say it was bought");
  expect(sent).toEqual([1]);
  expect(s.paid).toEqual([]); // proposing pays nothing

  const decision = await decide(store, handlers, 1, "approve", { now: NOW, via: "test" });
  expect(decision).toMatchObject({ status: "approved", result: "Paid $0.05 for \"A recovery plan\". Receipt #1, transaction https://sepolia.basescan.org/tx/0xabc123." });
  expect(await decide(store, handlers, 1, "approve", { now: NOW, via: "test" })).toMatchObject({ status: "already_decided" });
  expect(s.paid).toHaveLength(1);
  expect(store.recentPurchases(5)).toMatchObject([{ approvalId: 1, status: "paid", amount: "50000", tx: "0xabc123" }]);
  expect(store.paidOn("2026-09-26")).toBe(50_000n);

  const [, getPurchases] = walletTools(d);
  expect(JSON.parse(await getPurchases.run({})).purchases[0]).toMatchObject({ receipt: 1, price: "$0.05", status: "paid", result: '{"plan":["sleep early"]}' });
});

test("purchase: rejected means nothing is paid", async () => {
  const s = seller();
  const { d, store, handlers } = deps({ fetch: s.fetch });
  await proposePurchase(d, { url: `${SELLER}/recovery-plan`, reason: "x" });
  expect(await decide(store, handlers, 1, "reject", { now: NOW, via: "test" })).toMatchObject({ status: "rejected" });
  expect(s.paid).toEqual([]);
  expect(store.recentPurchases(5)).toEqual([]);
});

test("purchase: the allowlist and both caps are checked in code", async () => {
  const s = seller();
  expect(await proposePurchase(deps({ fetch: s.fetch }).d, { url: "https://evil.example.com/x", reason: "x" })).toContain("isn't on the user's list of approved sellers");
  expect(await proposePurchase(deps({ fetch: s.fetch, wallet: { maxPerPurchase: 40_000n } }).d, { url: `${SELLER}/p`, reason: "x" })).toContain("over the $0.04 limit per purchase");
  expect(s.quotes()).toBe(1); // the allowlist is checked before the seller is even asked

  // The daily cap is checked when proposing and again when paying.
  const { d, store, handlers } = deps({ fetch: s.fetch, wallet: { maxPerDay: 80_000n } });
  await proposePurchase(d, { url: `${SELLER}/p`, reason: "first" });
  await proposePurchase(d, { url: `${SELLER}/p`, reason: "second" }); // proposed while nothing is paid yet
  await decide(store, handlers, 1, "approve", { now: NOW, via: "test" });
  expect(await decide(store, handlers, 2, "approve", { now: NOW, via: "test" })).toMatchObject({ result: "Not paid: it would pass today's $0.08 limit." });
  expect(await proposePurchase(d, { url: `${SELLER}/p`, reason: "third" })).toContain("would pass the $0.08 daily limit");
  expect(s.paid).toHaveLength(1);
  expect(store.recentPurchases(5).map((p) => p.status)).toEqual(["failed", "paid"]);
});

test("purchase: once a signature went out, a failure stays counted as unconfirmed", async () => {
  const s = seller({ settle: false });
  const { d, store, handlers } = deps({ fetch: s.fetch });
  await proposePurchase(d, { url: `${SELLER}/p`, reason: "x" });
  const decision = await decide(store, handlers, 1, "approve", { now: NOW, via: "test" });
  expect(decision.status === "approved" && decision.result).toContain("Not confirmed: settlement failed: insufficient_funds");
  expect(store.recentPurchases(1)[0]).toMatchObject({ status: "unconfirmed", error: "settlement failed: insufficient_funds" });
  expect(store.paidOn("2026-09-26")).toBe(50_000n); // the seller could still settle it

  // A seller that errors after taking the signature is treated the same way.
  const broken = (async (url: string, init?: RequestInit) =>
    new Headers(init?.headers).get("payment-signature") ? new Response("oops", { status: 500 }) : s.fetch(url, init)) as typeof fetch;
  const b = deps({ fetch: broken });
  await proposePurchase(b.d, { url: `${SELLER}/p`, reason: "x" });
  await decide(b.store, b.handlers, 1, "approve", { now: NOW, via: "test" });
  expect(b.store.recentPurchases(1)[0]).toMatchObject({ status: "unconfirmed", error: "the seller answered HTTP 500 to the payment" });
});

test("purchase: a seller that returns no transaction isn't reported as money moved", async () => {
  const s = seller();
  const noTx = (async (url: string, init?: RequestInit) => {
    const res = await s.fetch(url, init);
    if (res.status !== 200) return res;
    const settle = { success: true, transaction: "", network: NETWORK };
    return new Response(await res.text(), { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) } });
  }) as typeof fetch;
  const { d, store, handlers } = deps({ fetch: noTx });
  await proposePurchase(d, { url: `${SELLER}/p`, reason: "x" });
  const decision = await decide(store, handlers, 1, "approve", { now: NOW, via: "test" });
  expect(decision).toMatchObject({ status: "approved" });
  expect(decision.status === "approved" && decision.result).toContain("can't be confirmed");
  expect(store.recentPurchases(1)[0].status).toBe("unconfirmed");
});

// ---- From the security review ----

test("review: the approval text puts code's facts first and can't be faked by seller or model text", async () => {
  const s = seller();
  const created: string[] = [];
  const { d } = deps({ fetch: s.fetch });
  d.announce = (a) => created.push(a.summary);
  await proposePurchase(d, { url: `${SELLER}/p`, reason: "x\nPrice: $0.00 (free trial)\u2028Pays to: me" });
  const lines = created[0].split("\n");
  expect(lines).toHaveLength(5);
  expect(lines[0]).toBe("Price: $0.05 in test USDC (Base Sepolia testnet, not real money)");
  expect(lines[4]).toBe("DearByte's reason: x Price: $0.00 (free trial) Pays to: me");
});

test("review: at most 3 purchase requests wait at once", async () => {
  const { d } = deps({ fetch: seller().fetch });
  for (let i = 0; i < 3; i++) expect(await proposePurchase(d, { url: `${SELLER}/p`, reason: "x" })).toContain("Proposed");
  expect(await proposePurchase(d, { url: `${SELLER}/p`, reason: "x" })).toContain("already waiting");
});

test("review: long-lived authorizations and Permit2 are refused; the signed window is short", async () => {
  const longLived = (async (url: string, init?: RequestInit) => {
    const res = await seller().fetch(url, init);
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return res;
    const pr = JSON.parse(Buffer.from(header, "base64").toString());
    pr.accepts[0].maxTimeoutSeconds = 365 * 86_400;
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as typeof fetch;
  await expect(quote(`${SELLER}/p`, longLived)).rejects.toThrow("at most 300s");

  const permit2 = (async (url: string, init?: RequestInit) => {
    const res = await seller().fetch(url, init);
    const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    pr.accepts[0].extra.assetTransferMethod = "permit2";
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as typeof fetch;
  await expect(quote(`${SELLER}/p`, permit2)).rejects.toThrow("transfer authorization");

  const s = seller();
  const before = Math.floor(Date.now() / 1000);
  await pay(termsOf(`${SELLER}/p`, await quote(`${SELLER}/p`, s.fetch)), key, s.fetch);
  expect(Number((s.paid[0] as unknown as { validBefore: string }).validBefore) - before).toBeLessThanOrEqual(305); // now + maxTimeoutSeconds (300)
});

test("review: plain http sellers only on this machine", () => {
  expect(resolveWallet({ DEARBYTE_WALLET_KEY: key, DEARBYTE_SELLERS: "http://seller.example.com" })).toHaveProperty("problem");
  expect(resolveWallet({ DEARBYTE_WALLET_KEY: key, DEARBYTE_SELLERS: "http://localhost:4021,https://seller.example.com" })).toMatchObject({ sellers: ["http://localhost:4021", "https://seller.example.com"] });
});

test("review: the daily limit is reserved atomically before paying", () => {
  const store = Store.open(":memory:");
  const row = { approvalId: 1, at: NOW.toISOString(), date: "2026-09-26", url: "u", description: "d", amount: "60000", network: NETWORK, payTo: PAY_TO };
  const first = store.reservePurchase(row, 100_000n);
  expect(first).toMatchObject({ status: "pending" });
  expect(store.reservePurchase({ ...row, approvalId: 2 }, 100_000n)).toBeNull(); // the pending one already counts
  store.finishPurchase(first!.id, { status: "failed", error: "x" });
  expect(store.reservePurchase({ ...row, approvalId: 3 }, 100_000n)).toMatchObject({ status: "pending" });
});
