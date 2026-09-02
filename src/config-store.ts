/**
 * The runtime-confirmed group id, set by /setup in the bot rather than a
 * deploy-time secret. Lives in KV, not D1, because it is read on essentially
 * every request and KV is the cheap-read binding for exactly that shape of
 * data. KV wins over TELEGRAM_GROUP_ID when both are present, so /setup can
 * always (re)point the gate even for an operator who originally pinned a
 * group via the env var.
 */
const GROUP_ID_KEY = 'config:telegram_group_id';

/** A group the bot was just added to, awaiting an admin's /setup confirm. */
const PENDING_GROUP_KEY = 'pending:group_detect';

export interface PendingGroup {
  id: string;
  title: string;
  detectedAt: string;
}

export async function getConfiguredGroupId(kv: KVNamespace): Promise<string | null> {
  return kv.get(GROUP_ID_KEY);
}

export async function setConfiguredGroupId(kv: KVNamespace, groupId: string): Promise<void> {
  await kv.put(GROUP_ID_KEY, groupId);
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
