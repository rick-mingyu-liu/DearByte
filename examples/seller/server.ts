// An example seller for DearByte's wallet: two small paid resources behind
// x402. Ask without paying and it answers 402 with its price; pay and it
// answers with the resource and a receipt. This will move to its own repo
// (dearbyte-labs/seller-example) as the start of the seller SDK.
//
//   npm run seller            testnet: payments are verified and settled on
//                             Base Sepolia by the x402.org facilitator
//   npm run seller -- --dev   no chain: the signature is checked here and
//                             nothing is settled (for demos before the
//                             wallet has test USDC)
//
// SELLER_PAY_TO is the address that gets paid (required on testnet).
// SELLER_PORT defaults to 4021.

import { createServer, type ServerResponse } from "node:http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { verifyTypedData } from "viem";
import { NETWORK, USDC } from "../../src/wallet/config.ts";

const dev = process.argv.includes("--dev");
const port = Number(process.env.SELLER_PORT || 4021);
const payTo = process.env.SELLER_PAY_TO?.trim() || (dev ? "0x000000000000000000000000000000000000dEaD" : "");
if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error("Set SELLER_PAY_TO to the address that should get paid (or run with --dev).");
  process.exit(1);
}
const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

type Product = { price: string; description: string; body: () => unknown };

/** Generic advice only: an example seller shouldn't invent facts. */
const PRODUCTS: Record<string, Product> = {
  "/recovery-plan": {
    price: "50000", // $0.05
    description: "A one-day recovery plan after a short night of sleep",
    body: () => ({
      title: "Recovery plan for a short-sleep day",
      steps: [
        "Get daylight within an hour of waking; it helps reset your body clock.",
        "Caffeine before 1 p.m. only, so tonight's sleep isn't cut short too.",
        "Swap hard training for easy movement: a 20-30 minute walk or light mobility.",
        "If you nap, keep it under 25 minutes and before 3 p.m.",
        "Aim for bed 30-60 minutes earlier than usual tonight.",
      ],
      note: "General wellness guidance, not medical advice.",
    }),
  },
  "/deep-work-plan": {
    price: "30000", // $0.03
    description: "A deep-work schedule for a day with low energy",
    body: () => ({
      title: "Deep work on a low-energy day",
      steps: [
        "Put the hardest task in your first 90 minutes, before email and chat.",
        "Work in 50-minute blocks with 10-minute breaks away from screens.",
        "Batch meetings and admin into the afternoon dip.",
        "Stop at a clear next step, so tomorrow starts easily.",
      ],
    }),
  },
};

function requirements(p: Product): PaymentRequirements {
  return { scheme: "exact", network: NETWORK, asset: USDC, amount: p.price, payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } } as PaymentRequirements;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Dev mode: the authorization is signed by its sender and matches the offer. Nothing is settled. */
async function verifyLocally(payload: PaymentPayload, req: PaymentRequirements): Promise<string | null> {
  const p = payload.payload as { signature?: `0x${string}`; authorization?: Record<string, string> };
  const auth = p.authorization;
  if (!auth || !p.signature) return "missing authorization";
  if (auth.to?.toLowerCase() !== req.payTo.toLowerCase()) return "pays someone else";
  if (BigInt(auth.value) < BigInt(req.amount)) return "pays too little";
  if (Number(auth.validBefore) * 1000 < Date.now()) return "expired";
  const ok = await verifyTypedData({
    address: auth.from as `0x${string}`,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
    signature: p.signature,
  }).catch(() => false);
  return ok ? null : "bad signature";
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const product = req.method === "GET" ? PRODUCTS[url.pathname] : undefined;
  if (!product) return send(res, 404, { error: "not found", products: Object.keys(PRODUCTS) });
  const offer = requirements(product);
  const paymentRequired = { x402Version: 2, resource: { url: url.href, description: product.description, mimeType: "application/json" }, accepts: [offer] } as PaymentRequired;

  const signature = req.headers["payment-signature"];
  if (typeof signature !== "string") {
    console.log(`quote   ${url.pathname} $${Number(product.price) / 1e6}`);
    return send(res, 402, {}, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
  }
  try {
    const payload = decodePaymentSignatureHeader(signature);
    let settle: SettleResponse;
    if (dev) {
      const problem = await verifyLocally(payload, offer);
      if (problem) return send(res, 402, { error: problem }, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ ...paymentRequired, error: problem }) });
      settle = { success: true, transaction: "", network: NETWORK, extra: { dev: "signature checked, nothing settled" } } as SettleResponse;
    } else {
      const verified = await facilitator.verify(payload, offer);
      if (!verified.isValid) return send(res, 402, { error: verified.invalidReason }, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ ...paymentRequired, error: verified.invalidReason }) });
      settle = await facilitator.settle(payload, offer);
      if (!settle.success) return send(res, 402, { error: settle.errorReason }, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ ...paymentRequired, error: settle.errorReason }) });
    }
    console.log(`paid    ${url.pathname}${settle.transaction ? ` tx ${settle.transaction}` : " (dev: not settled)"}`);
    send(res, 200, product.body(), { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) });
  } catch (err) {
    console.error(`error   ${url.pathname}: ${(err as Error).message}`);
    send(res, 400, { error: "couldn't process the payment" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Example seller on http://127.0.0.1:${port} (${dev ? "dev: no chain" : "Base Sepolia testnet"}), paying ${payTo}`);
  for (const [path, p] of Object.entries(PRODUCTS)) console.log(`  GET ${path}  $${Number(p.price) / 1e6}  ${p.description}`);
});
