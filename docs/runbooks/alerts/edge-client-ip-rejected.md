# Alert: edge-client-ip-rejected

`edge_client_ip_rejected_total` increased during every evaluation of a 10-minute window: the API refused a
**signed client address** that the Cloudflare Pages Function sent (`x-qnsc-edge-ip` / `-ts` / `-sig`).

## What this means

The Function signs the visitor's address with `EDGE_CLIENT_IP_SECRET` (address, timestamp, method, path) and the
API's `clientIp()` verifies it. Behind a Pages Function the API's `cf-connecting-ip` is a Cloudflare address shared by
every visitor, so a refused signature does **not** fail the request: it silently falls back to that shared address.
Rate limiting (`AUTH_LOGIN` is 5 attempts per 15 minutes) and the access log's `ip` then describe Cloudflare, not the
person. That is why this alert exists: nothing else notices.

The `reason` label says why: `bad_signature` (different secrets, or a different path or method than the one signed),
`stale` (timestamp more than 60 s from the API's clock: a clock problem, or a replay), `incomplete` (some but not all of
the three headers), `malformed` (a header that is not the expected shape), `not_ip` (the signed address is not an IP
literal) and `unverifiable` (no usable key on the API).

## First checks

1. The API log: a warning "Refused signed edge client IPs since the last report: bad_signature=12 …" (at most one a
   minute, with a hint). It never contains a header value.
2. Did a rotation just happen? The order is API first (`EDGE_CLIENT_IP_SECRET` = new, `EDGE_CLIENT_IP_SECRET_PREVIOUS`
   = old), **then** the Pages secret and a web redeploy, then drop `_PREVIOUS`. A Pages secret changed before the API
   knows it gives `bad_signature` on every request until the API catches up.
3. Do the two values match? Compare the bundle key `edge-client-ip-secret` in `opshub/<env>/app` with the Pages secret
   `EDGE_CLIENT_IP_SECRET` (surrounding whitespace is ignored on both ends; nothing else is).
4. Is the Function deployed from the current code? A Function signing a different path than the API receives (a rewrite
   in the Function) fails verification: `apps/web/functions/_lib/proxy.ts` signs exactly the path it sends.
5. Is somebody calling the API origin directly with `x-qnsc-edge-*` headers (a scanner, a misconfigured client)? Those
   rejections are harmless to users and the alert will stay on until they stop; find them by the log's `ip`.

## Escalate if

Rejections persist after both ends are confirmed identical, or `AUTH_LOGIN` 429s appear for users who have not failed to
sign in: the shared-address bucket is already limiting people.
