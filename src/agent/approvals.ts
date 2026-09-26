// Approvals: the one path by which the agent gets to do something that needs
// the user's yes, such as spending money. The model can only propose. Code
// stores the proposal, sends it with Approve/Reject buttons, and runs the
// action only after an approval that arrived in time, from the user's chat.
// Each approval is decided once; a late or repeated tap changes nothing.

import type { Approval, Store } from "../storage/store.ts";

/** An unanswered approval lapses after this long. */
export const APPROVAL_TTL_MS = 15 * 60_000;

export type ApprovalStore = Pick<Store, "createApproval" | "approval" | "decideApproval">;

/** Runs an approved action and says what happened, in a line for the user. */
export type ApprovalHandler = (a: Approval) => Promise<string>;
export type ApprovalHandlers = Record<string, ApprovalHandler>;

/** What the user sees: the proposal and how long they have. */
export function approvalText(a: Approval): string {
  return `Approval needed\n\n${a.summary}\n\nThis expires in ${Math.round(APPROVAL_TTL_MS / 60_000)} minutes.`;
}

export function proposeApproval(store: Pick<ApprovalStore, "createApproval">, p: { kind: string; summary: string; payload: unknown }, now: Date): Approval {
  return store.createApproval({ ...p, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString() });
}

export type Decision =
  | { status: "approved"; approval: Approval; result: string }
  | { status: "rejected"; approval: Approval }
  | { status: "unknown" | "expired" | "already_decided"; approval: Approval | null };

/**
 * Records the user's answer and, on an approval, runs the handler for its kind.
 * A kind with no handler is never approved: the action couldn't run anyway.
 */
export async function decide(
  store: ApprovalStore,
  handlers: ApprovalHandlers,
  id: number,
  verdict: "approve" | "reject",
  o: { now: Date; via: string },
): Promise<Decision> {
  const existing = store.approval(id);
  if (!existing) return { status: "unknown", approval: null };
  if (existing.status !== "pending") return { status: "already_decided", approval: existing };
  const handler: ApprovalHandler | undefined = Object.hasOwn(handlers, existing.kind) ? handlers[existing.kind] : undefined;
  const status = verdict === "approve" && handler ? "approved" : "rejected";
  const decided = store.decideApproval(id, status, o.now.toISOString(), o.via);
  if (!decided) {
    const now = store.approval(id);
    return { status: now?.status === "pending" ? "expired" : "already_decided", approval: now };
  }
  if (decided.status === "rejected") return { status: "rejected", approval: decided };
  // A failing action is reported, not retried: the user can propose it again.
  const result = await handler!(decided).catch((err: Error) => `It was approved, but the action failed: ${err.message}`);
  return { status: "approved", approval: decided, result };
}
