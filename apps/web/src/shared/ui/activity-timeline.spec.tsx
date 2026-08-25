// @vitest-environment jsdom
/**
 * The audit trail on a record — and, above all, the difference between "nothing happened" and
 * "I could not read what happened".
 *
 * WHAT THIS PINS AND WHY IT MATTERS MORE THAN IT LOOKS. This component's error branch used to fall
 * through to the empty state, so a failed request rendered "No activity recorded yet." — the product
 * asserting that a record has no history, in an app whose ISMS and QMS modules exist to produce
 * exactly that history.
 *
 * It was not an edge case. The query reads `/v1/audit-logs`, which requires `audit.read`, and three of
 * the eight seeded roles — manager, helpdesk, employee — do not hold it. `EntityDetailPanel` mounts
 * this component, so for those roles every detail drawer in the product (~27 of them) claimed the
 * record had never been touched.
 *
 * So the assertion that carries the weight is the NEGATIVE one: on failure, the empty-state sentence
 * must not be on screen. A test that only checked for an error message would pass while both were
 * rendered.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
vi.mock('@/shared/api/client', () => ({ api: { GET: (...a: unknown[]) => GET(...a) } }));

import { ActivityTimeline } from './activity-timeline';

const EVENT = {
  id: 'al-1',
  action: 'risk.identified',
  resourceType: 'risk',
  resourceId: 'r-1',
  actorId: '00000000-0000-7000-8000-000000000003',
  actorEmail: 'security@opshub.local',
  createdAt: '2026-08-21T09:00:00.000Z',
  before: null,
  after: null,
};

/** `retry: false`, or a rejected query spends the test's budget retrying before it reports. */
function renderIn(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const EMPTY_COPY = /No activity recorded yet/i;
const UNREADABLE_COPY = /Couldn.t load the history/i;

describe('ActivityTimeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not claim a record is empty when the history could not be read', async () => {
    // What a 403 looks like through the generated client: an `error`, no `data`.
    GET.mockResolvedValue({ data: undefined, error: { status: 403 } });
    renderIn(<ActivityTimeline resourceId="r-1" resourceType="risk" />);

    expect(await screen.findByText(UNREADABLE_COPY)).toBeTruthy();
    /*
     * THE LOAD-BEARING ASSERTION. Before the fix this sentence was what a failed request rendered, and
     * it is a false statement about a compliance record rather than merely an unhelpful one.
     */
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it('names the likeliest cause without blaming the reader', async () => {
    /*
     * For three of eight roles the cause is a permission they were never granted and cannot grant
     * themselves, so the copy has to offer that explanation rather than suggesting they retry forever.
     */
    GET.mockResolvedValue({ data: undefined, error: { status: 403 } });
    renderIn(<ActivityTimeline resourceId="r-1" resourceType="risk" />);

    expect(await screen.findByText(/permission to read the audit trail/i)).toBeTruthy();
    // Announced, because a reader who has already scrolled past needs telling.
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('still says a genuinely empty record is empty', async () => {
    /*
     * The other half. Without it, reporting every state as unreadable would also pass — and a record
     * that truly has no history is the ordinary case on the day it is created.
     */
    GET.mockResolvedValue({ data: { data: [] }, error: undefined });
    renderIn(<ActivityTimeline resourceId="r-1" resourceType="risk" />);

    expect(await screen.findByText(EMPTY_COPY)).toBeTruthy();
    expect(screen.queryByText(UNREADABLE_COPY)).toBeNull();
  });

  it('renders the history when it can read it', async () => {
    GET.mockResolvedValue({ data: { data: [EVENT] }, error: undefined });
    renderIn(<ActivityTimeline resourceId="r-1" resourceType="risk" />);

    expect(await screen.findByText(/security@opshub.local/i)).toBeTruthy();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    expect(screen.queryByText(UNREADABLE_COPY)).toBeNull();
  });
});
