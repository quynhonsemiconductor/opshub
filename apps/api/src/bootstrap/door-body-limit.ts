/**
 * Route-level body cap for the door-terminal listener (SA review #493 item 6). Fastify enforces
 * bodyLimit on the STREAM of received bytes, so chunked or missing Content-Length cannot slip past
 * a header pre-check. A batch is at most 100 events x ~200 bytes; 64 KB is an order of magnitude
 * above honest traffic and far below anything worth parsing.
 */
export const DOOR_TERMINAL_BODY_LIMIT = 64 * 1024;

/**
 * True for the device-facing terminal routes only (`/v1/door/terminal/allow-list`,
 * `/v1/door/terminal/events`). The trailing slash is what keeps the admin `/v1/door/terminals`
 * listing (and its CRUD routes) at the default limit.
 */
export function isDoorTerminalRoute(url: unknown): boolean {
  return typeof url === 'string' && url.startsWith('/v1/door/terminal/');
}
