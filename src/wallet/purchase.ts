// Buying things for the user. The model can call propose_purchase and
// nothing more: code asks the seller its price, checks the allowlist and
// the caps, and turns the proposal into an approval request. Only the
// "purchase" approval handler pays, only after the user's yes, and it
// checks the daily cap again at that moment. Every attempt leaves a
// receipt in purchases.

import { z } from "zod";
import { localDate } from "../companion/time.ts";
import { proposeApproval, type ApprovalHandler } from "../agent/approvals.ts";
import { defineTool, type Tool } from "../agent/tools.ts";
import type { Approval, Store } from "../storage/store.ts";
import { EXPLORER_TX, formatUsd, originOf, type WalletConfig } from "./config.ts";
import { pay, PaymentError, quote, termsOf } from "./x402.ts";

export type WalletDeps = {
  wallet: WalletConfig;
  store: Pick<Store, "createApproval" | "paidOn" | "recordPurchase" | "recentPurchases">;
  timeZone: string;
  /** Sends a new approval request to the user (Telegram); resolves to whether it arrived. */
  sendApproval?: (a: Approval) => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => Date;
};

const Payload = z.object({
  terms: z.object({ url: z.string(), amount: z.string().regex(/^\d+$/), payTo: z.string(), network: z.string(), asset: z.string() }),
  description: z.string(),
  reason: z.string(),
});

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Checks a proposal and turns it into an approval request. Returns what to tell the model. */
export async function proposePurchase(d: WalletDeps, p: { url: string; reason: string }): Promise<string> {
  const now = (d.now ?? (() => new Date()))();
  const origin = originOf(p.url);
  if (!origin) return "Error: that isn't an http(s) address.";
  if (!d.wallet.sellers.includes(origin)) {
    return `Error: ${origin} isn't on the user's list of approved sellers, so DearByte won't buy from it. The user can add it to DEARBYTE_SELLERS.`;
  }
  let q;
  try {
    q = await quote(p.url, d.fetch);
  } catch (err) {
    return `Error: ${(err as Error).message}.`;
  }
  const amount = BigInt(q.accept.amount);
  if (amount > d.wallet.maxPerPurchase) {
    return `Error: it costs ${formatUsd(amount)}, over the ${formatUsd(d.wallet.maxPerPurchase)} limit per purchase. Nothing was proposed.`;
  }
  const spent = d.store.paidOn(localDate(now, d.timeZone));
  if (spent + amount > d.wallet.maxPerDay) {
    return `Error: it costs ${formatUsd(amount)}, and ${formatUsd(spent)} was already spent today; that would pass the ${formatUsd(d.wallet.maxPerDay)} daily limit. Nothing was proposed.`;
  }
  const summary = [
    `Buy: ${q.description}`,
    `From: ${origin}`,
    `Price: ${formatUsd(amount)} in test USDC (Base Sepolia testnet, not real money)`,
    `Why: ${p.reason}`,
    `Pays to: ${short(q.accept.payTo)}`,
  ].join("\n");
  const approval = proposeApproval(d.store, { kind: "purchase", summary, payload: { terms: termsOf(p.url, q), description: q.description, reason: p.reason } }, now);
  const sent = d.sendApproval ? await d.sendApproval(approval).catch(() => false) : false;
  return [
    `Proposed purchase #${approval.id}: ${q.description} for ${formatUsd(amount)}. Nothing is paid unless the user approves within 15 minutes.`,
    sent ? "The approval request is in their Telegram." : "",
    `They can also approve in the terminal: /approve ${approval.id} in chat, or npm run agent -- approve ${approval.id}.`,
    "Tell the user what you proposed and why, and that it waits for their approval. Don't say it was bought.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Pays for an approved purchase and records the receipt. Returns the line the user sees. */
export function purchaseHandler(d: WalletDeps): ApprovalHandler {
  return async (a) => {
    const now = (d.now ?? (() => new Date()))();
    const date = localDate(now, d.timeZone);
    const parsed = Payload.safeParse(a.payload);
    if (!parsed.success) return "The request was malformed, so nothing was paid.";
    const { terms, description } = parsed.data;
    const amount = BigInt(terms.amount);
    const record = (r: { status: "paid" | "failed"; tx?: string | null; error?: string; result?: string }) =>
      d.store.recordPurchase({
        approvalId: a.id,
        at: now.toISOString(),
        date,
        url: terms.url,
        description,
        amount: terms.amount,
        network: terms.network,
        payTo: terms.payTo,
        status: r.status,
        tx: r.tx ?? null,
        error: r.error ?? null,
        result: r.result ?? null,
      });
    // Checked again now: other purchases may have been paid since this was proposed.
    if (d.store.paidOn(date) + amount > d.wallet.maxPerDay) {
      record({ status: "failed", error: "daily limit" });
      return `Not paid: it would pass today's ${formatUsd(d.wallet.maxPerDay)} limit.`;
    }
    try {
      const paid = await pay(terms, d.wallet.key, d.fetch);
      const receipt = record({ status: "paid", tx: paid.tx, result: paid.result });
      if (!paid.tx) {
        return `Sent a signed ${formatUsd(amount)} payment for ${description}, and the seller delivered it. Receipt #${receipt.id}. The seller reported no on-chain transaction, so no money moved (a dev-mode seller does this).`;
      }
      return `Paid ${formatUsd(amount)} for ${description}. Receipt #${receipt.id}, transaction ${EXPLORER_TX}${paid.tx}.`;
    } catch (err) {
      const message = err instanceof PaymentError ? err.message : `the payment failed: ${(err as Error).message}`;
      record({ status: "failed", error: message });
      return `Not paid: ${message}.`;
    }
  };
}

export function walletTools(d: WalletDeps): Tool[] {
  return [
    defineTool({
      name: "propose_purchase",
      description:
        "Proposes buying something for the user from an approved seller's x402 (pay-per-request) URL. DearByte checks the seller's price, the per-purchase and daily limits, and then asks the user to approve. Nothing is paid by this tool: payment happens only if the user approves. Use it only when buying clearly helps with what the user asked for or needs.",
      input: z.object({
        url: z.string().describe("The seller's URL for the thing to buy"),
        reason: z.string().min(1).max(300).describe("One sentence for the user: why this purchase helps them"),
      }),
      run: async (input) => proposePurchase(d, input),
    }),
    defineTool({
      name: "get_purchases",
      description: "The user's recent purchases through DearByte's wallet: what, when, price, whether it was paid, the receipt, and what the seller sent back.",
      input: z.object({}),
      run: async () => {
        const list = d.store.recentPurchases(5).map((p) => ({
          receipt: p.id,
          what: p.description,
          when: p.at,
          price: formatUsd(BigInt(p.amount)),
          status: p.status,
          ...(p.tx ? { transaction: `${EXPLORER_TX}${p.tx}` } : {}),
          ...(p.error ? { error: p.error } : {}),
          ...(p.result ? { result: p.result.slice(0, 4000) } : {}),
        }));
        return JSON.stringify(list.length ? { status: "ok", purchases: list } : { status: "empty" });
      },
    }),
  ];
}
