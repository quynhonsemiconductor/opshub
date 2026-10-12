#!/usr/bin/env python3
"""
opshub write-path smoke: drive every module's core happy path against a running API.

Purpose is finding 5xx, not asserting business rules. A 5xx is unambiguous: the server
broke. 4xx is recorded but only judged by eye, because some are legitimate (a review of an
already-resolved row, a precondition guard doing its job).

Runs in dependency order so later flows have real ids to work with.
"""
import json
import urllib.request
import urllib.error
import uuid
from datetime import date, datetime, timedelta, timezone

ORIGIN = 'http://localhost:3001'
BASE = ORIGIN + '/v1'
results = []  # (module, method, path, status, note)


def call(module, method, path, body=None, token=None, note=''):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header('content-type', 'application/json')
    if token:
        # a session from login(): the cookie, plus the CSRF half for anything that changes state
        req.add_header('cookie', token['cookie'])
        req.add_header('x-csrf-token', token['csrf'])
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = r.read().decode()
            results.append((module, method, path, r.status, note))
            try:
                return r.status, json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                return r.status, {}
    except urllib.error.HTTPError as e:
        payload = e.read().decode()[:200]
        results.append((module, method, path, e.code, (note + ' ' + payload).strip()))
        try:
            return e.code, json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            return e.code, {}
    except Exception as e:  # noqa: BLE001 - network/timeout, recorded not raised
        results.append((module, method, path, 0, f'{note} {type(e).__name__}: {e}'))
        return 0, {}


def _cookies(headers):
    """name=value of every Set-Cookie header, joined for a Cookie request header."""
    return '; '.join(c.split(';')[0] for c in headers.get_all('set-cookie') or [])


def login(email):
    """Sign in through identity 8's test login (IDENTITY_TEST_LOGIN=enabled, NODE_ENV test/development)."""
    req = urllib.request.Request(
        ORIGIN + '/api/auth/test-login', data=json.dumps({'email': email}).encode(), method='POST')
    req.add_header('content-type', 'application/json')
    req.add_header('origin', 'http://localhost:5173')  # Better Auth checks the Origin of every write
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            session = _cookies(r.headers)
        me = urllib.request.Request(BASE + '/auth/me')
        me.add_header('cookie', session)
        with urllib.request.urlopen(me, timeout=20) as r:
            csrf_cookie = _cookies(r.headers)
            body = json.loads(r.read().decode())
        return {'cookie': f'{session}; {csrf_cookie}', 'csrf': body['csrfToken']}
    except Exception as e:  # noqa: BLE001
        results.append(('auth', 'POST', '/api/auth/test-login', 0, f'{email}: {type(e).__name__}: {e}'))
        return None


today = date.today()
d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
ts = lambda n: (datetime.now(timezone.utc) + timedelta(hours=n)).strftime('%Y-%m-%dT%H:%M:%S.000Z')  # noqa: E731
rnd = lambda: uuid.uuid4().hex[:8]  # noqa: E731

ADMIN = login('admin@opshub.local')
EMP = login('employee@opshub.local')
HR = login('hr@opshub.local')
MGR = login('manager@opshub.local')
if not ADMIN:
    raise SystemExit('admin login failed — cannot smoke')

# ── employees ────────────────────────────────────────────────────────────────
_, emp = call('employees', 'POST', '/employees',
              {'email': f'smoke-{rnd()}@opshub.local', 'displayName': 'Smoke Employee',
               'department': 'IT', 'jobTitle': 'Engineer'}, ADMIN)
eid = emp.get('id')
if eid:
    call('employees', 'PATCH', f'/employees/{eid}', {'jobTitle': 'Senior Engineer'}, ADMIN)
    call('employees', 'PATCH', f'/employees/{eid}/status', {'status': 'active'}, ADMIN)
    _, pre = call('employees', 'POST', f'/employees/{eid}/avatar/presign',
                  {'fileName': 'a.png', 'mimeType': 'image/png', 'sizeBytes': 5}, ADMIN)
    if pre.get('fileId'):
        call('employees', 'POST', f'/employees/{eid}/avatar/confirm',
             {'fileId': pre['fileId']}, ADMIN, note='(no bytes uploaded)')

# ── assets ───────────────────────────────────────────────────────────────────
_, asset = call('assets', 'POST', '/assets',
                {'assetTag': f'SMK-{rnd()}', 'type': 'laptop', 'manufacturer': 'Dell'}, ADMIN)
aid = asset.get('id')
if aid and eid:
    call('assets', 'POST', f'/assets/{aid}/assign', {'employeeId': eid, 'notes': 'smoke'}, ADMIN)
    _, pre = call('assets', 'POST', f'/assets/{aid}/photo/presign',
                  {'fileName': 'p.png', 'mimeType': 'image/png', 'sizeBytes': 5}, ADMIN)
    if pre.get('fileId'):
        call('assets', 'POST', f'/assets/{aid}/photo/confirm', {'fileId': pre['fileId']}, ADMIN,
             note='(no bytes uploaded)')
    call('assets', 'POST', f'/assets/{aid}/unassign', None, ADMIN)
    call('assets', 'POST', f'/assets/{aid}/retire', None, ADMIN)

# ── catalog ──────────────────────────────────────────────────────────────────
_, cat = call('catalog', 'POST', '/catalog',
              {'name': f'Smoke Item {rnd()}', 'category': 'software',
               'approvalPermission': 'access_request.security_approve', 'sortOrder': 1}, ADMIN)
cid = cat.get('id')
if cid:
    call('catalog', 'PATCH', f'/catalog/{cid}', {'isActive': True}, ADMIN)
    call('catalog', 'POST', f'/catalog/{cid}/request', {'reason': 'smoke request'}, EMP)
    call('catalog', 'DELETE', f'/catalog/{cid}', None, ADMIN)

# ── licenses ─────────────────────────────────────────────────────────────────
_, lic = call('licenses', 'POST', '/licenses',
              {'name': f'Smoke License {rnd()}', 'vendor': 'Acme',
               'licenseType': 'per_seat', 'seatCount': 5}, ADMIN)
lid = lic.get('id')
if lid:
    call('licenses', 'PATCH', f'/licenses/{lid}', {'seatCount': 6}, ADMIN)
    if eid:
        _, seat = call('licenses', 'POST', f'/licenses/{lid}/assignments',
                       {'employeeId': eid}, ADMIN)
        if seat.get('id'):
            call('licenses', 'DELETE', f'/licenses/assignments/{seat["id"]}', None, ADMIN)
    call('licenses', 'DELETE', f'/licenses/{lid}', None, ADMIN)

# ── workforce ────────────────────────────────────────────────────────────────
_, leave = call('workforce', 'POST', '/workforce/leave',
                {'leaveType': 'annual', 'startDate': d(7), 'endDate': d(8),
                 'reason': 'smoke'}, EMP)
lvid = leave.get('id')
if lvid:
    _, pre = call('workforce', 'POST', f'/workforce/leave-requests/{lvid}/document/presign',
                  {'fileName': 'doc.pdf', 'mimeType': 'application/pdf', 'sizeBytes': 5}, EMP)
    if pre.get('fileId'):
        call('workforce', 'POST', f'/workforce/leave-requests/{lvid}/document/confirm',
             {'fileId': pre['fileId']}, EMP, note='(no bytes uploaded)')
    call('workforce', 'POST', f'/workforce/leave/{lvid}/review', {'approve': True}, HR)

_, ot = call('workforce', 'POST', '/workforce/overtime',
             {'workDate': d(-1), 'hours': 2, 'reason': 'smoke'}, EMP)
if ot.get('id'):
    call('workforce', 'POST', f'/workforce/overtime/{ot["id"]}/review', {'approve': True}, MGR)

call('workforce', 'POST', '/workforce/shifts',
     {'shiftType': 'on_call', 'startsAt': ts(1), 'endsAt': ts(9)}, EMP)

_, tsheet = call('workforce', 'POST', '/workforce/timesheets',
                 {'workDate': d(-1), 'minutesWorked': 480}, EMP)
if tsheet.get('id'):
    call('workforce', 'POST', f'/workforce/timesheets/{tsheet["id"]}/submit', None, EMP)
    call('workforce', 'POST', f'/workforce/timesheets/{tsheet["id"]}/review',
         {'approve': True}, MGR)

if eid:
    call('workforce', 'POST', '/workforce/onboarding',
         {'employeeId': eid, 'startDate': d(14), 'department': 'IT',
          'equipmentType': 'laptop', 'preferredOs': 'macos'}, HR)
    call('workforce', 'POST', '/workforce/offboarding',
         {'employeeId': eid, 'reason': 'smoke'}, HR)

# ── access requests + generic request engine ─────────────────────────────────
_, ar = call('access-requests', 'POST', '/access-requests',
             {'accessType': 'app_admin', 'target': 'jira',
              'justification': 'smoke verification run', 'durationHours': 8}, EMP)
arid = ar.get('id')
if arid:
    call('access-requests', 'POST', f'/access-requests/{arid}/approve', {'note': 'ok'}, ADMIN)
    call('requests', 'POST', f'/requests/{arid}/comments', {'body': 'smoke comment'}, ADMIN)

_, ar2 = call('access-requests', 'POST', '/access-requests',
              {'accessType': 'vpn', 'target': 'corp',
               'justification': 'smoke reject', 'durationHours': 4}, EMP)
if ar2.get('id'):
    call('access-requests', 'POST', f'/access-requests/{ar2["id"]}/reject', {'note': 'no'}, ADMIN)

# ── authz ────────────────────────────────────────────────────────────────────
_, role = call('authz', 'POST', '/authz/roles',
               {'key': f'smoke-{rnd()}', 'name': 'Smoke Role', 'permissions': ['asset.read']},
               ADMIN)
rid = role.get('id')
if rid:
    call('authz', 'PUT', f'/authz/roles/{rid}/permissions',
         {'permissions': ['asset.read', 'license.read']}, ADMIN)
    _, asg = call('authz', 'POST', '/authz/assignments',
                  {'userId': '00000000-0000-7000-8000-000000000008', 'roleId': rid,
                   'scopeType': 'global'}, ADMIN)
    if asg.get('id'):
        call('authz', 'DELETE', f'/authz/assignments/{asg["id"]}', None, ADMIN)
    call('authz', 'DELETE', f'/authz/roles/{rid}', None, ADMIN)

_, dele = call('authz', 'POST', '/authz/delegations',
               {'toUserId': '00000000-0000-7000-8000-000000000004',
                'startsAt': ts(1), 'endsAt': ts(48), 'reason': 'smoke'}, ADMIN)
if dele.get('id'):
    call('authz', 'DELETE', f'/authz/delegations/{dele["id"]}', None, ADMIN)

# ── webhooks ─────────────────────────────────────────────────────────────────
_, sub = call('webhooks', 'POST', '/webhooks/subscriptions',
              {'url': 'https://example.invalid/hook',
               'secret': 'smoke-secret-at-least-16-chars',
               'events': ['request.submitted'], 'description': 'smoke'}, ADMIN)
sid = sub.get('id')
if sid:
    call('webhooks', 'PATCH', f'/webhooks/subscriptions/{sid}/active', {'active': False}, ADMIN)
    call('webhooks', 'DELETE', f'/webhooks/subscriptions/{sid}', None, ADMIN)

# ── compliance ───────────────────────────────────────────────────────────────
_, sw = call('compliance', 'POST', '/compliance/software',
             {'name': f'SmokeApp {rnd()}', 'publisher': 'Acme', 'listing': 'review'}, ADMIN)
if sw.get('id'):
    call('compliance', 'PATCH', f'/compliance/software/{sw["id"]}',
         {'listing': 'whitelisted'}, ADMIN)
call('compliance', 'POST', '/compliance/shadow-it/scan', None, ADMIN)

# ── security posture ─────────────────────────────────────────────────────────
call('security-posture', 'POST', '/security-posture/sync', None, ADMIN)

# ── notifications ────────────────────────────────────────────────────────────
call('notifications', 'PUT', '/notifications/preferences/request.submitted',
     {'inApp': True, 'email': False}, EMP)
call('notifications', 'DELETE', '/notifications/preferences/request.submitted', None, EMP)
call('notifications', 'PATCH', '/notifications/read-all', None, EMP)

# ── ai ───────────────────────────────────────────────────────────────────────
call('ai', 'POST', '/ai/chat', {'messages': [{'role': 'user', 'content': 'hello'}]}, ADMIN)

# ── endpoints the first pass skipped ────────────────────────────────────────
# grant revoke: needs a grant, which only a FINAL approval step creates
_, grants = call('access-requests', 'GET', '/access-requests/grants/me/active', None, EMP)
gl = grants if isinstance(grants, list) else (grants or {}).get('data') or []
if gl:
    call('access-requests', 'POST', f'/access-requests/grants/{gl[0]["id"]}/revoke', None, ADMIN)

# webhook delivery retry: needs a delivery row
_, dels = call('webhooks', 'GET', '/webhooks/deliveries', None, ADMIN)
dl = dels if isinstance(dels, list) else (dels or {}).get('data') or []
if dl:
    call('webhooks', 'POST', f'/webhooks/deliveries/{dl[0]["id"]}/retry', None, ADMIN)

# compliance findings
_, finds = call('compliance', 'GET', '/compliance/findings', None, ADMIN)
fl = finds if isinstance(finds, list) else (finds or {}).get('data') or []
if fl:
    call('compliance', 'POST', f'/compliance/findings/{fl[0]["id"]}/acknowledge', None, ADMIN)
if len(fl) > 1:
    call('compliance', 'POST', f'/compliance/findings/{fl[1]["id"]}/resolve',
         {'note': 'smoke', 'riskAccepted': False}, ADMIN)

# mark one notification read
_, notifs = call('notifications', 'GET', '/notifications', None, EMP)
nl = notifs if isinstance(notifs, list) else (notifs or {}).get('data') or []
if nl:
    call('notifications', 'PATCH', f'/notifications/{nl[0]["id"]}/read', None, EMP)

# generic engine: cancel a fresh request as its requester
_, ar3 = call('access-requests', 'POST', '/access-requests',
              {'accessType': 'other', 'target': 'misc',
               'justification': 'smoke cancel path', 'durationHours': 2}, EMP)
if ar3.get('id'):
    call('requests', 'POST', f'/requests/{ar3["id"]}/cancel', {'note': 'smoke'}, EMP)

# ── report ───────────────────────────────────────────────────────────────────
print(f'{len(results)} calls\n')
buckets = {}
for m, meth, p, st, note in results:
    buckets.setdefault(st // 100, []).append((m, meth, p, st, note))

for fam in sorted(buckets):
    label = {0: 'NETWORK/TIMEOUT', 2: '2xx OK', 4: '4xx', 5: '5xx SERVER ERROR'}.get(fam, fam)
    print(f'── {label}: {len(buckets[fam])}')

print('\n=== 5xx AND NETWORK FAILURES (defects) ===')
bad = buckets.get(5, []) + buckets.get(0, [])
if not bad:
    print('  none')
for m, meth, p, st, note in bad:
    print(f'  [{m}] {st} {meth} {p}\n      {note[:180]}')

print('\n=== 4xx (verify each is legitimate) ===')
for m, meth, p, st, note in buckets.get(4, []):
    print(f'  [{m}] {st} {meth} {p}\n      {note[:160]}')
