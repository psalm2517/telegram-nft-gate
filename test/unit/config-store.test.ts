import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingGroup,
  getConfiguredGroupId,
  getPendingGroup,
  setConfiguredGroupId,
  setPendingGroup,
} from '../../src/config-store.js';

describe('config-store group roles', () => {
  beforeEach(async () => {
    for (const key of ['config:telegram_group_id', 'config:gate_group_id', 'pending:group_detect']) {
      await env.KV.delete(key);
    }
  });

  it('stores main and gate group ids independently', async () => {
    await setConfiguredGroupId(env.KV, 'main', '-1001');
    await setConfiguredGroupId(env.KV, 'gate', '-1002');

    expect(await getConfiguredGroupId(env.KV, 'main')).toBe('-1001');
    expect(await getConfiguredGroupId(env.KV, 'gate')).toBe('-1002');
  });

  it('returns null for a role that has not been configured', async () => {
    expect(await getConfiguredGroupId(env.KV, 'main')).toBeNull();
  });

  it('setting one role does not touch the other', async () => {
    await setConfiguredGroupId(env.KV, 'main', '-1001');
    expect(await getConfiguredGroupId(env.KV, 'gate')).toBeNull();
  });

  it('round-trips a pending group', async () => {
    await setPendingGroup(env.KV, { id: '-1003', title: 'Test', detectedAt: '2026-01-01T00:00:00Z' });
    expect(await getPendingGroup(env.KV)).toEqual({
      id: '-1003', title: 'Test', detectedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('clears the pending group', async () => {
    await setPendingGroup(env.KV, { id: '-1003', title: 'Test', detectedAt: '2026-01-01T00:00:00Z' });
    await clearPendingGroup(env.KV);
    expect(await getPendingGroup(env.KV)).toBeNull();
  });
});
