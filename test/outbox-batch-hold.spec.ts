/**
 * How long a crashed worker can strand a batch.
 *
 * A relay claims `batchSize` rows and holds ALL of them for the SUM of their leases (they are worked one
 * after another). If the worker dies holding the batch, those rows are invisible to every other relay
 * until the hold lapses. So `batchSize x lease` is the worst-case stall after a crash, for every relay,
 * and it is bounded here: a new relay, or a longer lease, cannot quietly turn it into an hour.
 *
 * (A pass drains the queue by claiming again, so a small batch costs no throughput.)
 */
import { describe, expect, it } from 'vitest';
import {
  GraphAccountRelayService,
  GraphScanRelayService,
} from '@modules/graph/application/graph-task-relay.service';
import { EmailRelayService } from '@modules/notifications/application/email-relay.service';
import { NotificationRelayService } from '@modules/notifications/application/notification-relay.service';
import { WebhookRelayService } from '@modules/webhooks/application/webhook-relay.service';

interface Relay {
  batchSize: number;
  leaseMsFor(row: { kind?: string }): number;
}

const none = {} as never;
const relays: Array<[string, Relay, string | undefined]> = [
  ['EmailRelayService', new EmailRelayService(none, none, none) as unknown as Relay, undefined],
  ['WebhookRelayService', new WebhookRelayService(none, none) as unknown as Relay, undefined],
  [
    'NotificationRelayService',
    new NotificationRelayService(none, none, none, none, none, none) as unknown as Relay,
    undefined,
  ],
  [
    'GraphAccountRelayService',
    new GraphAccountRelayService(none, none, none, none, none, none) as unknown as Relay,
    'entra.account.reconcile',
  ],
];

/** The most a crash may hide a batch for. */
const MAX_STRAND_MS = 15 * 60_000;

describe('a crashed worker strands a batch for at most 15 minutes', () => {
  it.each(relays)('%s: batchSize x lease <= 15 min', (_name, relay, kind) => {
    const hold = relay.batchSize * relay.leaseMsFor({ kind });
    expect(hold).toBeLessThanOrEqual(MAX_STRAND_MS);
  });

  it('the scan relay, whose single row has a long lease, claims ONE row at a time', () => {
    const scan = new GraphScanRelayService(none, none, none, none, none, none) as unknown as Relay;
    expect(scan.batchSize).toBe(1);
  });
});
