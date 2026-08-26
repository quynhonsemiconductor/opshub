/**
 * A preference can only be set for a notification that exists.
 *
 * `PUT /notifications/preferences/:type` took the type as a bare `string` and stored whatever arrived.
 * That is what made the settings screen's thirteen toggles for events with no template convincing: the
 * row was written, `GET` read it back, and the switch stayed where the user put it. The preference was
 * real. The notification was not.
 *
 * Asserted through HTTP rather than against the service, because the value is a PATH PARAMETER — it
 * never passes through `UpsertPreferenceDto`, so a DTO-level test would prove nothing about the route
 * that accepts it.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, bearer, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let user: Session;

/** Every route here is `@SelfScoped`, so any authenticated caller is the right caller. */
beforeAll(async () => {
  app = await createTestApp();
  user = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

function errorCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

describe('notification preference types', () => {
  it('stores a preference for a real notification', () => {
    // The direction that proves the refusals below are about the TYPE and not a route that rejects
    // everything. `review.due` has a template and is scheduled by the review reminder.
    return app
      .inject({
        method: 'PUT',
        url: '/v1/notifications/preferences/review.due',
        headers: bearer(user),
        payload: { inApp: false, email: true },
      })
      .then((res) => {
        expect(res.statusCode, res.body).toBe(200);
        const pref = JSON.parse(res.body) as { type: string; inApp: boolean; email: boolean };
        expect(pref.type).toBe('review.due');
        expect(pref.inApp).toBe(false);
        expect(pref.email).toBe(true);
      });
  });

  it('refuses a preference for an event that has no template', async () => {
    // One of the thirteen the page used to offer. It reads like a plausible product feature, which is
    // exactly why nobody noticed it could not work.
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/preferences/workforce.leave_requested',
      headers: bearer(user),
      payload: { inApp: false, email: false },
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    // The message has to name the type, or a client cannot tell WHICH toggle it failed to save.
    expect(res.body).toContain('workforce.leave_requested');
  });

  it('did not store the refused preference', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/notifications/preferences',
      headers: bearer(user),
    });
    expect(res.statusCode, res.body).toBe(200);
    const types = (JSON.parse(res.body) as { type: string }[]).map((p) => p.type);
    // The whole defect was a row that existed and meant nothing. A 422 that still wrote would leave
    // the screen behaving exactly as it did before.
    expect(types).not.toContain('workforce.leave_requested');
    expect(types).toContain('review.due');
  });

  it('still accepts the wildcard, which is not a template', async () => {
    // `*` is the global mute. Validating against the template list must not have taken it away.
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/preferences/*',
      headers: bearer(user),
      payload: { inApp: false, email: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as { type: string }).type).toBe('*');
  });

  it('refuses to RESET a preference for an event that has no template', async () => {
    // The delete route took the same unvalidated parameter. It matters less — deleting a row that
    // should not exist is harmless — but a 204 here tells a client the type was recognised.
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/notifications/preferences/compliance.finding_resolved',
      headers: bearer(user),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
  });

  it('resets a real preference back to default', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/notifications/preferences/review.due',
      headers: bearer(user),
    });
    expect(res.statusCode, res.body).toBe(204);
  });
});
