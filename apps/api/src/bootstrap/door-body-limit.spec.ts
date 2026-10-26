import { describe, it, expect } from 'vitest';
import { isDoorTerminalRoute } from './door-body-limit';

describe('isDoorTerminalRoute', () => {
  it.each(['/v1/door/terminal/events', '/v1/door/terminal/allow-list'])(
    'matches the device route %s',
    (url) => {
      expect(isDoorTerminalRoute(url)).toBe(true);
    },
  );

  it.each([
    '/v1/door/terminals',
    '/v1/door/terminals/abc/token',
    '/v1/door/cards',
    '/v1/door/terminal',
    '/v1/door/terminal-events',
  ])('does NOT match the admin or unrelated route %s', (url) => {
    expect(isDoorTerminalRoute(url)).toBe(false);
  });

  it('rejects a non-string route url', () => {
    expect(isDoorTerminalRoute(undefined)).toBe(false);
  });
});
