/**
 * The worker's executor for Graph tasks: what each kind calls, what an unknown kind does, and that a
 * worker with Graph off claims nothing — so a queued offboarding waits for the app rather than being
 * dropped.
 */
import { describe, expect, it, vi } from 'vitest';
import { GRAPH_TASK } from '../graph-task';
import { GraphTaskRelayService } from './graph-task-relay.service';

interface Internals {
  processRow(row: {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    createdAt: Date;
  }): Promise<void>;
  fetchBatch(tx: unknown): Promise<unknown[]>;
}

function make(enabled = true) {
  const accounts = {
    setEnabled: vi.fn().mockResolvedValue(undefined),
    revokeSessions: vi.fn().mockResolvedValue(undefined),
  };
  const scan = { detectShadowIt: vi.fn().mockResolvedValue({ scanned: 0, newFindings: 0 }) };
  const posture = { runPostureSync: vi.fn().mockResolvedValue({ controls: 0 }) };
  const graph = { isEnabled: vi.fn().mockReturnValue(enabled) };
  const relay = new GraphTaskRelayService(
    {} as never,
    graph as never,
    accounts as never,
    scan as never,
    posture as never,
  );
  return { relay: relay as unknown as Internals, accounts, scan, posture, graph };
}

const row = (kind: string, payload: Record<string, unknown> = {}) => ({
  id: 'r1',
  kind,
  payload,
  attempts: 0,
  createdAt: new Date(),
});

describe('GraphTaskRelayService', () => {
  it('disables an account', async () => {
    const { relay, accounts } = make();
    await relay.processRow(row(GRAPH_TASK.ACCOUNT_SET_ENABLED, { entraOid: 'o1', enabled: false }));
    expect(accounts.setEnabled).toHaveBeenCalledWith('o1', false);
  });

  it('enables an account only when the payload says enabled === true', async () => {
    const { relay, accounts } = make();
    await relay.processRow(row(GRAPH_TASK.ACCOUNT_SET_ENABLED, { entraOid: 'o1', enabled: true }));
    await relay.processRow(row(GRAPH_TASK.ACCOUNT_SET_ENABLED, { entraOid: 'o2' }));
    expect(accounts.setEnabled.mock.calls).toEqual([
      ['o1', true],
      ['o2', false],
    ]);
  });

  it('revokes sessions', async () => {
    const { relay, accounts } = make();
    await relay.processRow(row(GRAPH_TASK.SESSIONS_REVOKE, { entraOid: 'o1' }));
    expect(accounts.revokeSessions).toHaveBeenCalledWith('o1');
  });

  it('runs a shadow-IT scan and a posture sync', async () => {
    const { relay, scan, posture } = make();
    await relay.processRow(row(GRAPH_TASK.SHADOW_IT_SCAN));
    await relay.processRow(row(GRAPH_TASK.POSTURE_SYNC));
    expect(scan.detectShadowIt).toHaveBeenCalledTimes(1);
    expect(posture.runPostureSync).toHaveBeenCalledTimes(1);
  });

  it('fails a row with no entraOid instead of calling Graph with an empty id', async () => {
    const { relay, accounts } = make();
    await expect(relay.processRow(row(GRAPH_TASK.SESSIONS_REVOKE, {}))).rejects.toThrow(/entraOid/);
    expect(accounts.revokeSessions).not.toHaveBeenCalled();
  });

  it('fails a row of an unknown kind, so it retries and dead-letters instead of vanishing', async () => {
    const { relay } = make();
    await expect(relay.processRow(row('entra.something.new'))).rejects.toThrow(
      /Unknown Graph task kind/,
    );
  });

  it('with Graph off, claims nothing: the tx is never queried and the rows stay pending', async () => {
    const { relay } = make(false);
    const tx = { select: vi.fn() };
    expect(await relay.fetchBatch(tx)).toEqual([]);
    expect(tx.select).not.toHaveBeenCalled();
  });
});
