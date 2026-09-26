// The wallet's limits, all enforced in code, never by the model:
//   - testnet only: Base Sepolia, test USDC (no real money in Phase 1)
//   - only sellers on the allowlist (by origin)
//   - a cap per purchase and a cap per day
//   - nothing is paid without the user's approval (see approvals.ts)

import { privateKeyToAccount } from "viem/accounts";

/** Base Sepolia, as x402 names networks (CAIP-2). */
export const NETWORK = "eip155:84532";
/** Circle's test USDC on Base Sepolia. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;
export const EXPLORER_TX = "https://sepolia.basescan.org/tx/";
export const RPC_URL = "https://sepolia.base.org";

export type WalletConfig = {
  /** The testnet private key; it never leaves this process except as signatures. */
  key: `0x${string}`;
  address: `0x${string}`;
  /** Seller origins the agent may buy from, like https://seller.example.com. */
  sellers: string[];
  /** Caps in USDC's smallest unit. */
  maxPerPurchase: bigint;
  maxPerDay: bigint;
};

export const DEFAULT_MAX_PER_PURCHASE = "0.25";
export const DEFAULT_MAX_PER_DAY = "1";

/** "0.05" → 50000n. Refuses anything that isn't a plain amount with at most 6 decimals. */
export function toUnits(usd: string): bigint | null {
  const m = usd.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  return m ? BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0")) : null;
}

/** 50000n → "$0.05". */
export function formatUsd(units: bigint): string {
  const whole = units / 10n ** BigInt(USDC_DECIMALS);
  const frac = (units % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${frac}`;
}

/** The origin of a seller URL, or null when it isn't http(s). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The wallet from the environment: null when no key is set, or the problem with the settings. */
export function resolveWallet(env: Record<string, string | undefined>): WalletConfig | { problem: string } | null {
  const key = env.DEARBYTE_WALLET_KEY?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { problem: "DEARBYTE_WALLET_KEY should be 0x followed by 64 hex characters (npm run agent -- wallet new makes one)" };
  const sellers: string[] = [];
  for (const s of (env.DEARBYTE_SELLERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const origin = originOf(s);
    if (!origin) return { problem: `DEARBYTE_SELLERS has something that isn't an http(s) address: ${s}` };
    sellers.push(origin);
  }
  const perPurchase = toUnits(env.DEARBYTE_MAX_PURCHASE?.trim() || DEFAULT_MAX_PER_PURCHASE);
  const perDay = toUnits(env.DEARBYTE_MAX_DAY?.trim() || DEFAULT_MAX_PER_DAY);
  if (perPurchase === null || perDay === null) return { problem: "DEARBYTE_MAX_PURCHASE and DEARBYTE_MAX_DAY should be dollar amounts like 0.25" };
  return { key: key as `0x${string}`, address: privateKeyToAccount(key as `0x${string}`).address, sellers, maxPerPurchase: perPurchase, maxPerDay: perDay };
}
