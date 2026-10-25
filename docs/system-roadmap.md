# OpsHub system roadmap — EMS, TMS, ISMS, QMS

OpsHub is one internal platform covering several management systems. This records what
exists today, the shared primitives that must be built once, and the order the remaining
systems should be built in — with the reasoning, because the order is driven by
dependencies rather than by which system is most interesting.

Written after an audit of `db/schema/**` and `libs/modules/**`, not from memory. Where it
says something is absent, that was checked.

## Where each system stands

| System                                    | State                                                                                                                       | Missing                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **TMS** — time management                 | Timesheets, leave, overtime and shift logs, each with a real approval workflow. Leave entitlement, balances, holiday calendar, working-day counting. **Accrual** over the year with **carry-over** between years, capped and lapsing. **Part-day leave** in halves, with portion-aware overlap | **Complete**                                                                                    |
| **EMS** — employee management             | Solid core. `identity.employees`; status transitions; onboarding/offboarding; assets; licences; access. **Positions** with headcount and assignment history. **Employment contracts**: terms, lifecycle, renewal, expiry sweep, pay gated separately. **Training**: course catalogue, per-position requirements, retraining chain, certificate uploads, competency gap report. **Performance reviews**: cycles, a frozen position, self-assessment, weighted goals, engine-approved calibration, employee acknowledgement, coverage report | **Complete**                                                                                    |
| **ISMS** — information security           | Substantial. Access control (RBAC + scoped PBAC), audit trail, compliance findings, security posture, asset inventory, controlled policies. **Risk register** with generated scoring and engine-approved acceptance. **Controls + SoA** with risk↔control coverage. **Incidents**: state machine, append-only timeline, 72-hour breach clock, risk feedback loop. **Information asset register**: classification levels with handling rules, named owners, CIA ratings, append-only classification history, declassification as a separate permission, device holdings. **Vendor risk**: criticality tiers with review cadence, due-diligence assessments, a go-live gate, GDPR Article 28 agreements, vendor↔risk links, unassessed-spend report | **Complete**                                                                                    |
| **QMS** — quality management              | Started. Controlled documents: versions, approval through the request engine, publish-supersedes, acknowledgement tracking. Competency records via EMS training. **Non-conformance register**: severity grades with policy, containment windows, a closure gate. **CAPA**: root-cause analysis, an effectiveness review that can fail and loops back, separation of duties on sign-off, recurrence detection. **Internal audit**: the programme, auditor rosters, a reporting gate before closure, findings that ARE non-conformances, and auditor impartiality on effectiveness reviews. **Management review**: the §9.3.2 agenda composed from every other register, frozen as a snapshot when the review is held, and §9.3.3 actions carried into the next one | **Complete**                                                            |

A caution on searching for these: grepping the schema for `risk`, `policy`, `document` or
`vendor` returns hits that are **not** domain tables — `risk_accepted` is a
finding-status enum value, `vendor` is a column on `licenses`, and
`document_storage_key` is a leave-request attachment. QMS and the ISMS items above are
genuinely absent.

## Three decisions that apply to every system

### 1. One approval spine, not one per system

`RequestEngine` (`libs/platform/src/requests/`) plus the `RequestTypeDef` registry already
provides multi-step approval chains, separation of duties, delegation, SLA deadlines,
expiry, audit entries, notifications and webhook fan-out. Eight types are registered today:
`access_request`, `onboarding`, `offboarding`, `leave_request`, `overtime`,
`catalog_request`, `document_approval`, `risk_acceptance`.

Almost every process in these systems is that same shape — a QMS document approval, a
CAPA, an ISMS risk treatment plan, an EMS contract sign-off. Each is a new
`RequestTypeDef` of roughly a hundred lines, declaring its steps and permissions and
supplying `onApprove`.

**The smell to watch for:** a module growing its own `status` column with hand-written
transitions and its own approver check. That is a second workflow engine, and it will not
have the SoD rule, the delegation union, the SLA cron or the audit entry.

Cashed in twice so far: `document_approval`, and `risk_acceptance` — accepting a residual
risk is the one ISMS decision that creates exposure by choice, so ISO 27001 wants a named
approver who is not the assessor. That is separation of duties, which the engine already
has. The risk module keeps only what the engine cannot know: the score being signed off,
frozen into the payload so re-scoring mid-approval cannot change what was approved.

### 2. Build "controlled document" ONCE

ISMS policies, QMS SOPs and work instructions, and EMS contracts and handbooks are all
the same primitive: a document with **versions**, an **approval** before publication, an
**acknowledgement** per employee, a **review-due date**, and **supersession** rather than
deletion.

Build it as one module that three systems consume. Getting this wrong means three schemas,
three approval flows and three acknowledgement tables — and then a question like "which
employees have not acknowledged the current version of anything?" cannot be answered with
one query.

It is deliberately sequenced before the systems that need it, because the second consumer
is what turns a shortcut into a rewrite.

### 3. The evidence trail already exists — do not rebuild it

ISO 9001 and ISO 27001 both require knowing who changed what and when. `audit.audit_logs`
plus the typed `AUDIT_ACTION` catalogue is that record, and audit entries now commit inside
the transaction that made the change, so an entry cannot describe something that did not
happen.

A new module records history by calling `AuditService.record(input, tx)` with a catalogue
action. It does not add a `*_history` table.

## Build order, and why this order

1. ~~**Finish TMS**~~ — **done**: leave entitlement, balances, holiday calendar,
   working-day calculation.
   Smallest piece of work, and it completed a system that was otherwise done.
   `leave_requests` used to store start and end dates with **no day count at all**, so
   leave was approved without anyone knowing what it cost or whether the employee had the
   days. A correctness gap in a shipped feature, which outranked new systems.

2. ~~**Controlled-document module**~~ — **done**: the shared primitive from decision 2,
   ahead of the ISMS policies and QMS SOPs that both need it.

3. ~~**EMS depth**~~ — **done**: positions and headcount, contracts, training records,
   performance reviews. **The system is complete.**
   Before QMS and ISMS, because QMS competency/training records and ISMS policy
   acknowledgement both hang off employee and position data. Building those first means
   modelling training twice.

   Positions landed first within this step for the same reason: a contract is a contract
   FOR a position and QMS competency is training required for A POSITION, so both would
   otherwise match on `employees.job_title`, which is free text on the person. That column
   is deliberately left in place — the Entra sync writes it and older screens read it.

   Contracts came second and confirmed the ordering: `employment_contracts.position_id` is a
   real reference, so "what does this role pay" and "who is on a fixed term ending this
   quarter" are both queries rather than string matching.

   Training closed the step and paid the ordering off completely: requirements hang off
   `position_id`, so the competency gap report reads each employee's CURRENT assignment and
   survives a transfer with no backfill. That is also the QMS competency artefact and the ISMS
   awareness-training evidence, so neither system needs its own model of it.

   Training was also the first upload surface that ACCUMULATES, which is why it brought
   `storage.attachments` and the policy descriptors with it — see the upload section below.

   Performance reviews closed the system, and paid the ordering off a second time: the review
   freezes `position_id` from the employee's CURRENT assignment, so "what was this person reviewed
   as" is a reference rather than a job-title string. Four decisions worth carrying forward:

   - **A CYCLE, NOT A YEAR COLUMN.** "Who has not been reviewed yet" is the question the feature
     exists to answer, and a year on the review row cannot answer it: an absent row means both "not
     due" and "overdue", and nothing says when the window closed. The cycle owns the period and the
     deadlines, so coverage is an anti-join — the same shape as the competency gap report.
   - **THE POSITION IS FROZEN AND THE ASSIGNMENT IS NOT**, which is the opposite choice from the gap
     report ON PURPOSE. A gap is a fact about now; a review is a record of then. Both read the same
     table and neither is wrong.
   - **THE SIGN-OFF IS THE REQUEST ENGINE'S** (`performance_review`, the ninth registered type),
     not an `approved_by` column with its own permission check. Two people are excluded for
     different reasons: the REVIEWER by `allowSelfApproval: false`, and the EMPLOYEE by a check in
     the type def — the engine cannot know a request has a SUBJECT, so without it anybody holding
     `performance.approve` could approve their own review.
   - **THE RATING SCALE IS THE FIFTH ENUM-KEYED REFERENCE TABLE WITH A RANK**, carrying
     `requires_development_plan` exactly as `nonconformance_severities` carries `requires_capa`. The
     gate is the same shape because the problem is: a grade that demands something of the
     organisation is worth nothing unless a row somewhere refuses without it.

4. **ISMS** — ~~risk register~~, ~~controls / Statement of Applicability~~, ~~incidents~~,
   ~~asset classification~~, ~~vendor risk~~ — **the system is complete**.
   Reuses compliance findings, the asset inventory, the access-control model and the
   document module, so most of its foundation is already here.

   The register came first because everything else in ISMS references it: a control exists to
   treat a risk, the SoA is the list of controls with the risks that justify them, and an
   incident is a risk that materialised. Built the other way round, each of those would need
   its own notion of "how bad is this".

   Two things worth carrying forward from it. `compliance.compliance_findings` was NOT
   extended into a risk table — `software_name` is NOT NULL there and every row is
   scan-detected, so findings are INPUTS to risks rather than risks. And scoring is a
   GENERATED column (`likelihood * impact`), which is why no API accepts a score: a register
   cannot hold a row that disagrees with its own factors.

   The SoA followed and confirmed the sequencing: a control exists to treat a risk, so
   `isms.risk_controls` turns "we have controls" into "this risk is treated by these", and the
   untreated-risk report is that join's anti-join. Three structural decisions worth carrying:

   - The CATALOGUE and the DECISION are separate tables. Merging them would let a re-seed of
     Annex A overwrite the organisation's justifications, and it would make "which controls
     have we not decided about yet?" unanswerable — an ABSENT `soa_entries` row is exactly
     that state, and no column value can distinguish it from "decided, no comment". That
     absence is what `undecided` in the coverage report counts.
   - The SoA is written with PUT, never PATCH. Applicability, justification and status are one
     statement; letting them change independently is how an entry ends up excluded while its
     rationale still argues for inclusion.
   - `ck_soa_applicability` pairs `applicable = false` with `not_applicable`, so "excluded but
     implemented" is unrepresentable rather than merely discouraged.

   Incidents closed the loop the register opened: `incidents.risk_id` is the risk that
   materialised, and "open incidents with no linked risk" is the gap in the assessment nobody
   had foreseen. Three decisions there are worth carrying:

   - **This is the one module that does NOT use the request engine, deliberately.** The engine
     models an APPROVAL — somebody decides yes or no, with separation of duties and an SLA on
     the decision. Incident handling is work under time pressure whose states are what has been
     ACHIEVED (contained, resolved), not what has been permitted; routing it through the engine
     would need an approver for "we have contained it". The state machine is a declared map
     (`ALLOWED_TRANSITIONS`) plus a guarded `WHERE status = <from>`, not an `if` chain.
   - **The timeline is append-only, and written BY the transition.** Every status change appends
     its entry in the same transaction, so a timeline can never be missing the step the status
     column claims happened — and there is no edit or delete route, because a timeline somebody
     can revise afterwards is not evidence.
   - **The 72-hour GDPR clock is derived in ONE query, not stored.** It was first written as a
     generated column and Postgres refused it: `timestamptz + interval` is only STABLE, and a
     generated column must be IMMUTABLE. See the checklist entry below.

   Asset classification came next, and the first decision was the one worth recording: it is a
   NEW table, not columns on `assets.assets`.

   - **`assets.assets` is the DEVICE inventory, not the asset register.** Asset tag, manufacturer,
     serial number, MDM device id, warranty expiry, a photo of the physical thing, and a status
     that runs `in_stock` → `assigned` → `in_repair` → `retired` → `lost`. An information asset is
     a payroll system, a customer database, a room of signed contracts. Widening the device table
     would have meant a fabricated `asset_tag` for "Customer CRM", `serial_number` and
     `warranty_expiry` permanently null, and a status enum that lies — a database is never
     `in_stock`. The tempting part was that `isms.risks.asset_id` and `isms.incidents.asset_id`
     ALREADY point at `assets.assets`, which looks like a reason to extend it; both still mean a
     device, and a lost-laptop incident reaches classification through
     `isms.information_asset_devices` rather than through a second nullable pointer.
   - **The link to hardware is a table, and it earns its place.** One laptop holds several
     information assets and one system lives on many laptops — but the real payoff is the question
     security asks the moment a device goes missing: WHAT WAS ON IT.
     `GET /information-assets/reports/device-holdings/:deviceAssetId` answers it worst-first.
   - **The RANK lives in a column, never in the enum's declaration order.** `isms.classification_levels`
     is keyed BY the enum, so a level and a label are one thing, and it is also where the handling
     rules live so they are stated once instead of copied per asset. Postgres does sort an enum by
     declaration order, which is exactly what makes relying on it dangerous: it appears to work
     until somebody appends a label and silently makes it the highest. The unit spec's stub returns
     the levels out of order with non-contiguous ranks, so a hard-coded ordering cannot pass.
   - **Direction is a permission, not a flag.** Raising a classification is `information_asset.manage`;
     LOWERING it is `information_asset.declassify`, which — like `risk.accept` — is in no default
     role bundle. Both routes call one private implementation, so there is a single set of rules,
     and the manage route ALSO refuses a reduction with a code: without that, holding `manage`
     would silently include the power to make information easier to reach. Coherence still
     outranks permission — even the wildcard holder cannot declassify personal data to `internal`.
   - **Only the extremes of the label-versus-rating relationship are constrained.** `public` with a
     confidentiality rating above the floor is a contradiction; `restricted` rated 1 or 2 means the
     label was applied without the assessment agreeing. The middle of the scale is left free
     deliberately — a CHECK forcing an exact mapping would make the rating a restatement of the
     label rather than an independent judgement.
   - **`GRANT` could not narrow the append-only table; `REVOKE` had to.** Migration 0019 set
     `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE` for the whole `isms`
     schema, so every table created there arrives holding all four. A narrower GRANT in migration
     0022 would have READ like a restriction and changed nothing. The same revoke was applied to
     `isms.incident_events` from 0021, which had been append-only in its port's comments and fully
     writable in the database since the day it shipped. See the checklist entry below.

   Vendor risk closed the system, and reused nearly everything the four modules before it
   established. Four decisions worth carrying:

   - **`vendor_criticality_levels` is the second reference table of exactly the shape
     `classification_levels` has** — keyed by the enum, `rank` in a column, and the policy that
     depends on the tier (`review_interval_months`) stated once. Two tables of one shape is not
     duplication when they describe different domains; what would be duplication is a second copy of
     the *ordering*, which is why neither reads the enum's declaration order.
   - **The go-live gate is the rule no CHECK can hold.** Activation requires the LATEST assessment to
     be a pass — a statement about another table's most recent row. `vendor.approve` is the third
     permission for an act that creates exposure by choice, after `risk.accept` and
     `information_asset.declassify`, and like both it is in no default bundle. Suspension and
     termination stay with `manage`: stopping is never the risky direction, and making the scarcer
     permission necessary to stop would be a reason not to.
   - **`software_licenses.vendor_id` was added ALONGSIDE the free-text `vendor`, not instead of it** —
     the same move `positions` made with `employees.job_title`, and for the same reasons. Nothing was
     backfilled: matching names to register rows is a judgement, and guessing it in a migration would
     silently attach spend to the wrong supplier. The `unassessed-spend` report is what makes the
     unlinked rows visible rather than forgotten, and it reports both shapes of the gap — unlinked,
     and linked-but-never-assessed — because they are one problem to whoever acts on them.
   - **The review date has ONE definition, and it lives in SQL.** It was first computed in TypeScript
     with `setUTCMonth` while the report derived it with `+ interval '1 month'`; those two disagree at
     month ends, so the date on the screen would have differed from the date the report tested. Now
     the service passes the inputs and Postgres does the arithmetic once, and every reader compares
     against the stored column. See the checklist entry below.

5. **QMS** — ~~non-conformance + CAPA~~, ~~internal audit~~, ~~management review~~ — **the system is complete**.
   Last of the four not because it matters least, but because it is the heaviest consumer
   of everything above: documents, training records, the request engine and the audit
   trail. Built last, it is mostly composition.

   Non-conformance and CAPA shipped TOGETHER, and that was the first decision. ISO 9001 §10.2 is
   one obligation in five parts — react, evaluate whether corrective action is needed, implement it,
   review whether it WORKED, record both. A register without CAPAs records that something went wrong
   and nothing was done; CAPAs without a register are floating actions nobody can trace to a cause.
   The rule that makes the pair worth having needs both tables to exist, so either alone would have
   been the half that enforces nothing. Four decisions worth carrying:

   - **The closure gate is the rule no CHECK can hold.** A finding whose grade `requiresCapa`
     cannot be closed until a CAPA is `verified` — a statement about rows in another table.
     `qms.nonconformance_severities` is the third reference table of the same shape as
     `isms.classification_levels` and `isms.vendor_criticality_levels`: keyed by its enum, `rank` in
     a column, and the policy that rank implies (`requires_capa`, `containment_due_days`) stated
     once and READ by the gate rather than restated in it. Re-grading a finding therefore tightens
     its closure requirement with no code change, which is what makes re-grading meaningful.
   - **`open → closed` is not legal, and the database taught me that.** The first draft of the state
     machine allowed a minor finding to close on its closure note alone; `ck_nc_contained_states` —
     written first — refused it, and the CHECK was right. §10.2(a) requires reacting to the
     nonconformity, so a finding that goes from "found" to "closed" with nothing recorded in between
     is exactly the box-ticking the clause exists to prevent. Both the map and the CHECK now say so.
   - **The effectiveness review can FAIL, and failing is not terminal.** `ineffective` returns the
     CAPA to `analysis`, the finding stays unclosable because no verified CAPA exists, and a second
     attempt records a different cause without touching the first attempt's evidence. A review that
     can only pass is not a review. `verified`, by contrast, IS terminal: revisiting after sign-off
     is a NEW CAPA, because re-opening the old one would overwrite the evidence somebody relied on.
   - **`capa.verify` is the fourth exposure permission,** after `risk.accept`,
     `information_asset.declassify` and `vendor.approve`, and in no default bundle. The service
     ALSO refuses a verifier who owns the CAPA — in both directions, pass and fail — because a
     permission says who MAY sign and not whether the signature means anything.

   The recurrence report is the one worth knowing about: a process area with a CAPA already verified
   effective AND a finding raised after that verification. Two findings in one area is ordinary; a
   finding that arrives after somebody signed off a fix is evidence the review was wrong. It needs
   both dates, so it is one query rather than a number on a dashboard.

   Internal audit followed, and it added almost no new concepts — which was the point. Four decisions:

   - **AN AUDIT FINDING IS A NON-CONFORMANCE.** `nonconformances.source` already carried
     `internal_audit` and §9.2.2(e) is the CAPA machinery §10.2 built, so the audit gains a pointer
     FROM the register (`internal_audit_id`) and nothing else. A separate `audit_findings` table would
     have duplicated the grade, the containment, the closure gate and the CAPA link, and the two
     copies would have disagreed about what "closed" means within a week.
   - **The pointer is NULLABLE and the gap is a report.** A finding written up during fieldwork before
     the engagement row exists is the normal order of events for a small team, so requiring the link
     would push that record-keeping out of the system. `reports/unlinked-findings` is the third report
     of this shape, after the risk register's unlinked incidents and the vendor register's unassessed
     spend.
   - **Reporting is a STATE, not a timestamp on closure.** §9.2.2(d) makes reporting to management its
     own obligation, so `closed` is only reachable from `reported`, and reaching `reported` needs both
     a conclusion and the report document. An audit whose fieldwork finished and whose results never
     reached anybody has not been done. Closing does NOT require the findings to be closed — that is
     the CAPA gate's job per finding, and an audit held open until every action is verified would stay
     open for months.
   - **The roster exists for the IMPARTIALITY rule.** §9.2.2(c): somebody who audited a finding may
     not sign off that the corrective action for it worked. That is enforced in `CapaService`, at the
     verification, because a rule enforced anywhere else is one the verification can be reached
     without — and it applies in BOTH review directions, since a review the auditor may fail but not
     pass is still the auditor deciding. An `observer` is deliberately not an auditor for this: sitting
     in to learn does not compromise a later review.

   Management review closed the system, and it is the module the whole roadmap's "mostly composition"
   claim was about. Three decisions:

   - **§9.3.2 IS A JOIN, not a table.** Every input the clause lists is something another register
     already answers: nonconformities and corrective actions (c)(4) is the recurrence and
     containment-overdue reports, audit results (c)(6) is the unlinked-findings report, the performance
     of external providers (c)(7) is the vendor review gaps and unassessed spend, and the effectiveness
     of actions on risks (e) is the untreated-risk report. `ManagementReviewService` asks those four
     services and stores no copy — a second copy of "how many findings are overdue" disagrees with the
     register within a day. `QmsModule` imports `IsmsModule` for exactly this and nothing else.
   - **Holding a review FREEZES that join.** `management_reviews.inputs` is the composed bundle as it
     stood on the day, because minutes have to show the numbers a decision was taken against. A live
     re-read would turn "eleven findings overdue" into "three" once the backlog cleared and leave the
     decision beside it unexplainable. This is the same frozen-versus-live split the reporting module
     draws between a burndown and a velocity query. `jsonb` rather than columns because the bundle's
     members change whenever a register adds a report — three did in three migrations — and a column
     per metric would mean a migration each time with every historical row backfilled to a value
     nobody measured. No API accepts `inputs`.
   - **§9.3.2(a) is satisfied by construction.** "The status of actions from previous management
     reviews" is the open actions of every OTHER review, and holding a review freezes that list into
     its own inputs. Reviews are therefore held in scheduled order — a review cannot be held while an
     earlier one is still outstanding, because "previous" has to be settled for the input to mean
     anything. A review is never offered its own freshly-raised actions as history: that exclusion
     survived four of five mutations and needed its own assertion to pin, which is recorded in the
     spec. This is the second, independent separation on the
     same route, alongside "the verifier may not own the CAPA".

**Not on this list, and blocking all of it for real users:** `infra/` has never been
applied — there is no deployed OpsHub environment. Every module above is verifiable
locally and in CI, and none of it is usable by an employee until that happens. Decide
whether it lands before or alongside module 1.

## Uploads: one policy descriptor per surface

Ported from rova, which arrived at this shape after every new upload surface had produced
another copy of presign/confirm.

- **`RESOURCE_RULES` in `libs/platform/src/storage/storage.types.ts`** is the whole policy: MIME
  allow-list, size ceiling, `maxPerOwner`, and `inlineDisposition`. The key of the entry is also
  the object-key prefix. Adding a surface is an entry here plus, for multi-file surfaces, link
  rows in `storage.attachments`. It is never a change to `StorageService`.
- **Mechanics in the platform, authorization in the owning module.** `EntityAttachmentsService`
  does presign / confirm / list / download / unlink and the quota; it never maps an entity type to
  a permission. The owning controller proves the subject exists and decides who may act, then
  delegates. An `entityType → permission` map inside the shared service is where cross-entity
  authorization bugs hide.
- **SVG is excluded from every policy, permanently.** It is active content, so an "image" that
  renders inline is stored XSS the moment the bytes come from an origin the app trusts — which is
  exactly what `CDN_FILES_BASE_URL` is.
- **`Content-Disposition` is STORED object metadata, not a response override.** This is a
  deliberate deviation from rova, which applies it on its presigned GET. `resolveUrl` here prefers
  the CDN whenever one is configured and a plain CDN read carries no overrides, so the override
  alone would silently not apply on the path production uses. The header must therefore be in
  `signableHeaders` AND sent by the client — a header named in the command but unsigned is dropped
  by the presigner, verified against LocalStack.
- **`requiredHeaders` is returned, not documented.** The client must send exactly that set: fewer
  fails the signature and so does more, and the failure is a 403 with no CORS headers, which a
  browser reports as an opaque network error.
- **The checksum is advisory.** A presigned PUT cannot require one without the client sending a
  matching `x-amz-*` header, which the presigner drops — rova proved that the hard way. It is
  recorded at presign and compared on confirm where the backend reports one, because size alone
  cannot catch a same-length substitution.
- **1:1 surfaces keep their key column.** `employees.photo_storage_key` and friends are not
  migrated onto the link table: the column IS the relationship, and a join per avatar render buys
  only uniformity.

## Shared primitives: use these, do not re-declare them

A codebase-wide audit on 2026-08-10, run before starting QMS, found the same failure mode seven
times: **something shared already existed and a second copy grew beside it.** Each one is now
consolidated, and each is listed here so the next module reaches for the existing thing.

| Concern | The one place | What it replaced |
| --- | --- | --- |
| Milliseconds and seconds | `MS_PER_HOUR`, `MS_PER_DAY`, `SEC_PER_DAY`… in `@shared-kernel/time` | 14 files hand-rolling `3_600_000`, `23 * 60 * 60_000`, `30 * 24 * 60 * 60 * 1000` |
| ISO-date arithmetic | `today`, `toIsoDate`, `addDays`, `addMonths` in `@shared-kernel/time` | `today()` implemented identically in contracts, the risk register and training |
| The ISMS 1..5 scale | `RATING_MIN`/`RATING_MAX`/`isRating` in `isms/domain/rating.ts` | four independent TS definitions; the two migration CHECKs now name this file |
| Date validation in DTOs | `z.string().date()` | a hand-rolled `/^\d{4}-\d{2}-\d{2}$/` in three DTOs, which also accepted `2026-02-31` |
| Writing an audit entry | `AuditService.recordChange` and `AuditService.forResource` | six private `record()` wrappers whose only content was flattening `Actor` |
| The audit catalogue | `@modules/audit` → `domain/audit-catalogue.ts` | a stale 40-key `AUDIT_ACTION` in `shared-kernel/constants.ts` |
| Faking audit in unit tests | `createFakeAudit()` in `@modules/audit` → `testing/audit.fake.ts` | ten copies of `{ record: vi.fn() }` |
| Driving the API in e2e | `apiRequest`, `unwrap`, `errorCode` in `test/e2e/support/harness.ts` | 24 copies across eight spec files |
| A status union in TS | `(typeof someEnum.enumValues)[number]` | three hand-written unions shadowing DB enums they could not track |

Two of these were more than untidiness:

- **The duplicate `AUDIT_ACTION` was a correctness trap, not just dead code.** Nothing imported it —
  every service reaches for `@modules/audit` — but `shared-kernel` is re-exported wholesale, so
  `import { AUDIT_ACTION } from '@shared-kernel'` resolved to the smaller set. Four keys carried
  DIFFERENT VALUES for the same event (`catalog.item_created` against `catalog_item.created`) and
  seven `RBAC_*` keys duplicated `role.*` under another name. Writing one and querying the other
  loses rows from the trail and nothing fails. `constants.ts` already documented an identical
  incident with a duplicate `PERMISSION` map — the same mistake, twice, in one file. The guard is
  `test/audit-catalogue-single-source.spec.ts`, which asserts each catalogue is declared in exactly
  one file and every value is unique; mutation-checked by adding a second declaration.
- **The narrower type was right, and now says so.** `WebhookDeliveryStatus` omits `sent`, which the
  shared `outbox_status` enum allows, because this relay overrides `markSent` to write `delivered`.
  Deriving it from the enum would have made it wider than reality and lost exhaustiveness. Left
  hand-written, with the reason recorded — the one case where NOT deriving is correct.

**Still open from that audit:** report limit defaults are bare literals (`limit = 50 | 100 | 200 |
500` across six services). `PAGE_SIZE.MAX` governs pagination; nothing governs report caps, and
picking one number needs a decision about what a report is for rather than a refactor.

## Checklist for a new module

The platform enforces most of this automatically; the ratchets will fail a PR that skips a
step, which is the point.

- **Structure** — `libs/modules/<name>/src/{domain,application,infrastructure,interface}`,
  with a repository port in `domain/ports` and a Drizzle implementation in
  `infrastructure/persistence`. Fifteen modules already follow this; copy the nearest one.
- **Schema** — a `pgSchema('<name>')` in `db/schema/`, plus a hand-written migration, plus an
  entry in `db/migrations/meta/_journal.json`. An unregistered SQL file is skipped SILENTLY:
  `pnpm db:migrate` prints "Migrations applied" and creates nothing.
- **Grants, if the migration adds a SCHEMA** — repeat the grant block from
  `0015_controlled_documents.sql`. Migration 0012 granted the least-privilege roles access by
  iterating the schemas that existed then, so a later schema is invisible to it and the runtime
  role can see it but read nothing in it. Local development cannot catch this — a developer
  connects as the owner, which is exempt — but CI runs its e2e suite as `opshub_app` on purpose
  and fails with a 500 on the first insert.
- **Authorization** — every route declares one of `@RequirePermission`, `@Public`,
  `@SelfScoped`, `@SharedRead`, `@AuthorizedInService` or `@AuthzGap`. The app **refuses to
  boot** on an undeclared route (`assertEveryRouteDeclaresAuthz`), so this is not optional.
  New permission codes go in `db/permissions.catalog.ts`; opshub's seed rewrites
  `role_permissions` per role, so a re-seed propagates them with no backfill migration.
- **Approvals** — a `RequestTypeDef`, not a bespoke status machine. See decision 1.
- **Audit** — `AuditService.record(input, tx)` inside the mutation's transaction, with new
  actions added to `AUDIT_ACTION`. An inline string is a compile error.
- **Ordering** — every `ORDER BY` ends in a unique column, or pagination silently drops
  rows. Enforced by `test/query-ordering.ratchet.spec.ts`.
- **Path params** — `@Param('id', ParseUUIDPipe)`, or a malformed id becomes a 500.
- **Scheduled work** — through `ExclusiveJob.run()`, or a second replica runs it twice.
- **Tests** — unit specs for the domain rules, an API e2e spec for the flow **and** for
  authorization in both directions, and one Playwright journey through the surface
  (`apps/web/e2e/`). A per-page smoke check is not a journey.
- **POST status** — a `@Post` that transitions state rather than creating a row needs
  `@HttpCode(HttpStatus.OK)` alongside its `@ApiOkResponse`. Nest answers 201 otherwise, so the
  OpenAPI document — and the client generated from it — promises a status the server never sends.
  15 routes across six controllers were doing this. Enforced by
  `test/post-status-contract.ratchet.spec.ts`, baseline 0.
- **Uploads** — a `RESOURCE_RULES` entry, and `EntityAttachmentsService` for anything that can
  own more than one file. Never a second copy of presign/confirm. E2E it against the LocalStack
  service in CI rather than a stubbed `StorageService`: a stub agrees with whatever the code does,
  and both real defects here (an unsigned header silently dropped, a presigned GET returning a
  Promise cast to a string) were invisible without real bytes.
- **E2E reset** — add every new table to `FIXTURE_TABLES` in `db/reset.ts`. Nothing in the
  suite tears down what it creates, so an unlisted table keeps its rows forever and the
  failure arrives later, in someone else's spec, looking like a product bug. Positions found
  this as `POSITION_INVALID_WINDOW` on a second run; the leave suite found it as arithmetic
  drifting once 12 years' worth of stale holidays had piled up. Both were "passes exactly
  once per database".
- **A route whose literal segment shares its shape with `:id` must be declared FIRST.** Nest matches
  in declaration order, so `PATCH /management-reviews/actions/<uuid>` reaches `PATCH :id` with
  `id = 'actions'` and `ParseUUIDPipe` turns it into a puzzling 400. Two-segment literals like
  `severities` or `criticality-levels` have the same trap. An e2e test that actually calls the nested
  route is the only thing that catches it — a unit test never sees the router.
- **A correlated subquery in a `sql` template needs EXPLICIT qualification.** Drizzle qualifies a
  column inside `sql` only when the OUTER query has a join. Without one,
  `${child.parentId} = ${parent.id}` renders `WHERE "parent_id" = "id"` and BOTH bare names bind to the
  inner table — the predicate becomes `child.parent_id = child.id`, always false, and the count is
  silently 0 rather than an error. Measured: the internal-audit programme reported `findingCount: 0`
  for an audit with two findings, while the identical shape on the non-conformance register was correct
  because that query happens to join. Write the outer reference as `schema.table.column` and alias the
  inner table; all four correlated counts in the codebase now do. Depending on a join for correctness
  means removing one silently breaks a count elsewhere in the file.
- **A CHECK that evaluates to NULL is a CHECK that passes.** `length(btrim(x)) >= 10` on a NULLABLE
  column yields NULL when `x` is null, and Postgres accepts NULL as satisfied — so
  `CHECK (outcome <> 'fail' OR length(btrim(findings)) >= 10)` accepts exactly the row it exists to
  reject: the one where the column was left out entirely. Wrap the nullable side in
  `coalesce(x, '')` (migration 0021 does; 0023 did not until it was probed). This is not visible by
  reading the constraint, which is why every implication CHECK has to be tested with the column
  OMITTED and not merely set to a bad value — the bad-value test passes either way.
- **A narrower `GRANT` does not narrow anything.** Both `isms` and any schema covered by
  migration 0012 carry `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
  TABLES`, so privileges are attached at `CREATE TABLE`, before any grant block in the migration
  runs. To make a table read-only or append-only you must `REVOKE`. Check the result rather than
  the intent: `SELECT has_table_privilege('opshub_app', 'schema.table', 'UPDATE')`. An append-only
  table that the application can still UPDATE is a comment, not a guarantee — `isms.incident_events`
  was exactly that for three migrations.
- **`pnpm typecheck` is the gate, not `tsc -b`.** They read different tsconfigs: `tsc -b` follows the
  project references and can report a clean build while `tsc --noEmit -p tsconfig.json` — which is
  what `pnpm typecheck` and CI run — rejects a spec file it never looked at. An invalid cast in a
  `.spec.ts` passed `tsc -b` locally and failed CI's typecheck. Run both before pushing; `tsc -b` is
  the fast loop, `pnpm typecheck` is the answer.
- **Generated columns must be IMMUTABLE.** `timestamptz + interval` is only STABLE — it depends on
  the session time zone and therefore on DST — so Postgres rejects it with
  `ERROR 42P17: generation expression is not immutable`. `likelihood * impact` on integers is fine;
  anything touching a timestamp and an interval is not. Derive it in the one query that needs it and
  index the column it is derived FROM.
- **Read every CHECK you write back to yourself.** Migration 0020's first draft carried
  `CHECK (a IS NOT NULL OR b IS NOT NULL OR TRUE)` — a tautology that can never fail, which would
  have sat in the schema looking like a guarantee while enforcing nothing. Same family as a ratchet
  that cannot fail: if you cannot state the row it rejects, it is not a constraint.
- **Invariants the database cannot hold** — count-based rules (`at most N open rows`) need a
  service check INSIDE the transaction, because a unique index cannot express them and a CHECK
  cannot see other rows. Where a CHECK *does* hold the rule, still refuse the bad input in the
  service: a raw constraint violation reaches the caller as a 500 with no error code.
