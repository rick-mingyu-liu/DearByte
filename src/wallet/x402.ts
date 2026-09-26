// Paying for an HTTP resource with x402, in two separate steps so the user's
// approval sits between them:
//   1. quote: request the resource; the seller answers 402 Payment Required
//      with what it accepts (network, token, amount, recipient).
//   2. pay: after approval, sign an EIP-3009 transfer authorization for
//      exactly the approved terms and request again with it; the seller
//      settles on chain and answers with the resource and a receipt.
// The stock x402 fetch wrapper pays automatically on any 402, which is why
// it isn't used here.

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK, USDC } from "./config.ts";

const TIMEOUT_MS = 30_000;
/** How much of a bought resource is kept. */
export const MAX_RESULT = 20_000;

export class PaymentError extends Error {}

export type Quote = {
  /** The seller's description of what it sells at this URL. */
  description: string;
  /** The one offer DearByte can pay: test USDC on Base Sepolia. */
  accept: PaymentRequirements;
  paymentRequired: PaymentRequired;
};

const readOnly = new x402HTTPClient(new x402Client());

async function request(url: string, headers: Record<string, string>, f: typeof fetch): Promise<Response> {
  try {
    return await f(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch (err) {
    throw new PaymentError(`${new URL(url).host} ${(err as Error).name === "TimeoutError" ? "timed out" : "could not be reached"}`);
  }
}

/** Asks the seller its price. Throws when it doesn't ask for payment, or not in a way DearByte can pay. */
export async function quote(url: string, f: typeof fetch = fetch): Promise<Quote> {
  const res = await request(url, {}, f);
  if (res.status !== 402) throw new PaymentError(`the seller answered HTTP ${res.status}, not a price (402)`);
  const body = await res.json().catch(() => ({}));
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = readOnly.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  } catch (err) {
    throw new PaymentError(`the seller's price couldn't be read: ${(err as Error).message}`);
  }
  // Only the exact scheme in test USDC on Base Sepolia; anything else (mainnet, another token) is refused.
  const accept = (paymentRequired.accepts as PaymentRequirements[]).find(
    (a) => a.scheme === "exact" && a.network === NETWORK && a.asset.toLowerCase() === USDC.toLowerCase() && /^\d+$/.test(a.amount),
  );
  if (!accept) throw new PaymentError("the seller doesn't accept test USDC on Base Sepolia");
  const resource = (paymentRequired as { resource?: { description?: string } }).resource;
  return { description: resource?.description?.trim() || "(no description)", accept, paymentRequired };
}

/** The terms the user approves; a new quote must match them to be paid. */
export type Terms = { url: string; amount: string; payTo: string; network: string; asset: string };

export const termsOf = (url: string, q: Quote): Terms => ({ url, amount: q.accept.amount, payTo: q.accept.payTo, network: q.accept.network, asset: q.accept.asset });

export type Paid = { tx: string | null; result: string; status: number };

/**
 * Pays for `terms` and returns the resource. Asks for a fresh quote first
 * and refuses if the seller changed the recipient or raised the price since
 * the user approved.
 */
export async function pay(terms: Terms, key: `0x${string}`, f: typeof fetch = fetch): Promise<Paid> {
  const fresh = await quote(terms.url, f);
  const a = fresh.accept;
  if (a.payTo.toLowerCase() !== terms.payTo.toLowerCase()) throw new PaymentError("the seller changed who gets paid since you approved; nothing was paid");
  if (BigInt(a.amount) > BigInt(terms.amount)) throw new PaymentError("the seller raised the price since you approved; nothing was paid");

  const client = new x402HTTPClient(new x402Client().register(NETWORK, new ExactEvmScheme(privateKeyToAccount(key))));
  // Sign for the one approved offer only.
  const payload = await client.createPaymentPayload({ ...fresh.paymentRequired, accepts: [a] } as PaymentRequired);
  const res = await request(terms.url, client.encodePaymentSignatureHeader(payload), f);
  const text = (await res.text()).slice(0, MAX_RESULT);
  if (!res.ok) throw new PaymentError(`the seller refused the payment (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  let tx: string | null = null;
  try {
    const settle = client.getPaymentSettleResponse((n) => res.headers.get(n));
    if (!settle.success) throw new PaymentError(`settlement failed: ${settle.errorReason ?? "unknown reason"}`);
    tx = settle.transaction || null;
  } catch (err) {
    if (err instanceof PaymentError) throw err;
    // A 200 without a receipt header: the resource came back, but there's no proof of payment.
  }
  return { tx, result: text, status: res.status };
}
