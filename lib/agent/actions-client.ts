/**
 * Server-backed action tracking (Intelligence 2.0) — same synchronous surface as the legacy
 * lib/agent/actions.ts (localStorage-only), so call sites swap one import. localStorage stays as
 * the OPTIMISTIC CACHE: mutators write it synchronously, broadcast to other tabs, and
 * fire-and-forget a POST to /api/agent/actions; refreshFromServer() reconciles (newest
 * lastActionAt wins) so managers and reps see one shared board. One-time migration: the first
 * refresh imports any legacy localStorage data to the server.
 */
import { WorkflowStatus } from "./ranking";

const ACTION_STORAGE_KEY = "sdr-attention-actions";
const MIGRATED_FLAG = "sdr-attention-actions-migrated";

export interface WatchAction {
  accountId: string;
  status: WorkflowStatus;
  lastActionAt: string | null;
  lastActionType: "call" | "email" | "meeting" | "note" | "snoozed" | null;
  snoozedUntil: string | null;
  notes: string[];
}

export function loadActions(): Map<string, WatchAction> {
  if (typeof window === "undefined") return new Map();
  try {
    const stored = localStorage.getItem(ACTION_STORAGE_KEY);
    if (!stored) return new Map();
    return new Map(Object.entries(JSON.parse(stored) as Record<string, WatchAction>));
  } catch {
    return new Map();
  }
}

function saveLocal(actions: Map<string, WatchAction>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ACTION_STORAGE_KEY, JSON.stringify(Object.fromEntries(actions)));
    const channel = new BroadcastChannel(ACTION_STORAGE_KEY);
    channel.postMessage({ type: "actions-update" });
    channel.close();
  } catch { /* storage full / channel unsupported */ }
}

function postUpdate(body: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  void fetch("/api/agent/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => { /* offline — the local cache still holds the change; next refresh reconciles */ });
}

/** Pull the shared server state, run the one-time legacy import, merge into the local cache
 *  (newest lastActionAt wins), and broadcast. Call once when the board mounts. */
export async function refreshFromServer(): Promise<Map<string, WatchAction>> {
  if (typeof window === "undefined") return new Map();
  const local = loadActions();

  try {
    if (!localStorage.getItem(MIGRATED_FLAG) && local.size > 0) {
      await fetch("/api/agent/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import: [...local.values()] }),
      });
      localStorage.setItem(MIGRATED_FLAG, "1");
    }

    const res = await fetch("/api/agent/actions");
    if (!res.ok) return local;
    const { actions } = (await res.json()) as {
      actions: { accountId: string; status: WorkflowStatus; lastActionType: WatchAction["lastActionType"]; lastActionAt: string | null; snoozedUntil: string | null; notes: { at: string; by: string | null; note: string }[] }[];
    };
    for (const a of actions ?? []) {
      const cur = local.get(a.accountId);
      if (!cur || (a.lastActionAt ?? "") >= (cur.lastActionAt ?? "")) {
        local.set(a.accountId, {
          accountId: a.accountId,
          status: a.status,
          lastActionAt: a.lastActionAt,
          lastActionType: a.lastActionType,
          snoozedUntil: a.snoozedUntil,
          notes: (a.notes ?? []).map((n) => `${n.at}: ${n.note}`),
        });
      }
    }
    saveLocal(local);
  } catch { /* server unreachable — local cache stands */ }
  return local;
}

export function getAction(accountId: string): WatchAction | null {
  return loadActions().get(accountId) ?? null;
}

export function getAllActions(): Map<string, WatchAction> {
  return loadActions();
}

export function updateAction(accountId: string, updates: Partial<WatchAction>): WatchAction {
  const actions = loadActions();
  const existing = actions.get(accountId);
  const now = new Date().toISOString();
  const newAction: WatchAction = {
    accountId,
    status: existing?.status ?? "not_started",
    lastActionAt: existing?.lastActionAt ?? null,
    lastActionType: existing?.lastActionType ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    notes: existing?.notes ?? [],
    ...updates,
    ...(updates.status && { lastActionAt: now }),
  };
  actions.set(accountId, newAction);
  saveLocal(actions);
  postUpdate({
    accountId,
    status: newAction.status,
    lastActionType: newAction.lastActionType,
    snoozedUntil: newAction.snoozedUntil,
  });
  return newAction;
}

export function markInProgress(accountId: string): WatchAction {
  return updateAction(accountId, { status: "in_progress" });
}

export function markCompleted(accountId: string, actionType?: "call" | "email" | "meeting" | "note"): WatchAction {
  return updateAction(accountId, { status: "completed", lastActionType: actionType ?? null });
}

export function snoozeWatch(accountId: string, days: number): WatchAction {
  const snoozedUntil = new Date();
  snoozedUntil.setDate(snoozedUntil.getDate() + days);
  return updateAction(accountId, { status: "snoozed", lastActionType: "snoozed", snoozedUntil: snoozedUntil.toISOString() });
}

export function resetWatch(accountId: string): WatchAction {
  return updateAction(accountId, { status: "not_started", snoozedUntil: null });
}

export function addActionNote(accountId: string, note: string): WatchAction {
  const actions = loadActions();
  const existing = actions.get(accountId);
  const newAction: WatchAction = {
    accountId,
    status: existing?.status ?? "not_started",
    lastActionAt: existing?.lastActionAt ?? null,
    lastActionType: existing?.lastActionType ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    notes: [...(existing?.notes ?? []), `${new Date().toISOString()}: ${note}`],
  };
  actions.set(accountId, newAction);
  saveLocal(actions);
  postUpdate({ accountId, note });
  return newAction;
}

export function shouldResurface(accountId: string): boolean {
  const action = getAction(accountId);
  if (!action?.snoozedUntil) return false;
  return new Date() >= new Date(action.snoozedUntil);
}

export function resurfaceExpired(): number {
  const actions = loadActions();
  let n = 0;
  for (const [accountId, action] of actions) {
    if (action.status === "snoozed" && shouldResurface(accountId)) {
      resetWatch(accountId);
      n++;
    }
  }
  return n;
}

export function initActionsListener(callback: () => void): void {
  if (typeof window === "undefined") return;
  try {
    const channel = new BroadcastChannel(ACTION_STORAGE_KEY);
    channel.addEventListener("message", (event) => {
      if (event.data?.type === "actions-update") callback();
    });
    (window as unknown as Record<string, unknown>).__actionsBroadcastChannel = channel;
  } catch { /* unsupported */ }
}

export function closeActionsListener(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  const channel = w.__actionsBroadcastChannel as BroadcastChannel | undefined;
  if (channel) {
    channel.close();
    w.__actionsBroadcastChannel = undefined;
  }
}
