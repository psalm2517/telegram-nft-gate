/**
 * Runtime-confirmed group state, set by /setup in the bot rather than a
 * deploy-time secret. Lives in KV, not D1, because it is read on essentially
 * every request and KV is the cheap-read binding for exactly that shape of
 * data.
 *
 * There are two roles, matching the two-group model the bot implements:
 *   - "main"  — the private, invite-only group granted after verification.
 *   - "gate"  — the public lobby group people join before verifying; the bot
 *               is not access-control-gating this one, just watching for
 *               joins to prompt them.
 *
 * A KV-confirmed value wins over the matching env var (TELEGRAM_GROUP_ID /
 * GATE_GROUP_ID) when both are present, so /setup can always (re)point either
 * group even for an operator who originally pinned one via env.
 */
export type GroupRole = 'main' | 'gate';

const GROUP_ID_KEY: Record<GroupRole, string> = {
  main: 'config:telegram_group_id',
  gate: 'config:gate_group_id',
};

/** A group the bot was just added to, awaiting an admin's /setup confirm. */
const PENDING_GROUP_KEY = 'pending:group_detect';

export interface PendingGroup {
  id: string;
  title: string;
  detectedAt: string;
}

export async function getConfiguredGroupId(kv: KVNamespace, role: GroupRole): Promise<string | null> {
  return kv.get(GROUP_ID_KEY[role]);
}

export async function setConfiguredGroupId(
  kv: KVNamespace,
  role: GroupRole,
  groupId: string,
): Promise<void> {
  await kv.put(GROUP_ID_KEY[role], groupId);
}

export async function getPendingGroup(kv: KVNamespace): Promise<PendingGroup | null> {
  return kv.get(PENDING_GROUP_KEY, 'json');
}

export async function setPendingGroup(kv: KVNamespace, pending: PendingGroup): Promise<void> {
  // Expires on its own if nobody ever confirms it, so a stale invite doesn't
  // linger forever as something /setup could still act on.
  await kv.put(PENDING_GROUP_KEY, JSON.stringify(pending), { expirationTtl: 7 * 24 * 60 * 60 });
}

export async function clearPendingGroup(kv: KVNamespace): Promise<void> {
  await kv.delete(PENDING_GROUP_KEY);
}
