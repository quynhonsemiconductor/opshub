# Infrastructure apply: the destructive guard

`.github/workflows/infra-apply.yml` plans, saves the plan (`tfplan`), runs the guard on that file, and applies that
same file. The guard (`quynhonsemiconductor/ci/actions/destructive-guard`) fails the job when the plan **deletes or
replaces** a DNS, edge, mail-identity, certificate or key resource: Cloudflare records, Pages, R2, tunnels and
workers, Route 53, SES, ACM, KMS, the CI OIDC roles. Updates and creates pass.

Why it exists: on 2026-10-09 a provider lock bump turned nine DNS/edge resources into "replace" (`zone_id -> null`);
the apply destroyed them, the re-creates failed, and a landing site, SES DKIM and an ACM validation record were down
for three days. A bare `tofu apply -auto-approve` had planned again and applied the result without anyone reading it.

## When it refuses

The job `apply-shared`, `apply-develop` or `apply-prod` fails at the step `destructive-guard (...)`, the log lists
each address with `DESTROY` or `REPLACE`, and the job summary shows the same list. Nothing has been applied by that
job yet (the apply is the next step). Read the list first. If it is **not** what you intended (a provider bump, a
lock-file change, an empty variable), something upstream is wrong: fix that, do not override.

## How to allow an intended destroy or replace

| Run | What allows it |
|---|---|
| push to `main` (develop) | the label **`allow-dns-destroy`** on the pull request that was merged |
| push of a `vX.Y.Z` tag (prod) | the label on the **release PR**: on a tag run the lookup resolves the tag's commit to the pull request that carries it, which is the release PR, not the feature PR that introduced the change |
| manual dispatch | the input **`allow_destructive`** set to true on that dispatch |

Add the label, then **re-run the failed job**: the label is read live from the API, not from the event that started
the run, so a label added after the failure is seen. The allowed addresses are written to the job summary, so the
record survives the label being removed. An override is for that change only; the next plan is judged afresh.

If the label lookup itself fails (no pull request found for the commit, an API error), the guard refuses. It never
opens on an error. A missing or empty plan also refuses.

## Notes

- The jobs have `pull-requests: read` for this lookup and nothing broader.
- `tfplan` holds the variable values, sensitive ones included. It stays on the runner and is never uploaded.
