import { api } from './client';
import type { PickerOption } from '@/shared/ui';

/**
 * Where an `EntityPicker`'s options come from, defined once per entity.
 *
 * Four forms need to name an employee and three need to name a course or a role. Written at each
 * call site, that is seven copies of "fetch, map to `{ value, label, hint }`, decide what the hint is" —
 * and the hint is a property of the ENTITY, not of the form: an employee is always best identified by
 * their department, a course by its code.
 *
 * SEARCHING IS SERVER-SIDE WHERE THE API SUPPORTS IT. `/v1/employees`, `/v1/roles`, `/v1/documents`
 * and `/v1/assets` all take `search` — roles only since this branch: the SPA had shipped a search box
 * for that list while the endpoint had no such parameter, so the term was dropped and the box filtered
 * nothing.
 *
 * `/v1/training/courses` still has none, so that one term filters a fetched page. Marked below, because a
 * client-side filter over one page silently stops finding things at 100 rows and must not be mistaken for
 * the real thing.
 */

/** How many rows a picker asks for. The API's ceiling is 100. */
const PICKER_LIMIT = 100;

function matches(term: string, ...fields: (string | null | undefined)[]): boolean {
  if (!term) return true;
  const needle = term.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/** People, searched by the API. */
export async function employeeOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/employees', {
    params: { query: { search: term || undefined, limit: PICKER_LIMIT, offset: 0 } },
  });
  return (data?.data ?? []).map((employee) => ({
    value: employee.id,
    label: employee.displayName,
    hint: employee.department ?? employee.email,
  }));
}

/** Only people who can still be assigned to things — a leaver is not a valid choice. */
export async function activeEmployeeOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/employees', {
    params: {
      query: { search: term || undefined, status: 'active', limit: PICKER_LIMIT, offset: 0 },
    },
  });
  return (data?.data ?? []).map((employee) => ({
    value: employee.id,
    label: employee.displayName,
    hint: employee.department ?? employee.email,
  }));
}

/**
 * Hardware assets — the DEVICES an information asset can be recorded as living on.
 *
 * SERVER-SIDE SEARCH, over the asset tag, serial number and model: those are what somebody reads off the
 * machine in front of them, and the hardware register is the one list here that grows with every laptop
 * bought.
 *
 * NO STATUS FILTER, unlike `controlOptions` and `documentOptions`, which both exclude retired rows. The
 * reasoning inverts here. A `lost` device is the one this link is most often needed for — "what was on it"
 * is asked BECAUSE the machine went missing — and a `retired` one still held what it held. Excluding
 * either would hide exactly the devices worth naming.
 */
export async function assetOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/assets', {
    params: { query: { search: term || undefined, limit: PICKER_LIMIT, offset: 0 } },
  });
  return (data?.data ?? []).map((asset) => ({
    value: asset.id,
    label: asset.assetTag,
    // What identifies a machine once its tag is ambiguous: the model on its lid, else the serial
    // underneath it, else at least what kind of thing it is.
    hint:
      [asset.manufacturer, asset.model].filter(Boolean).join(' ') ||
      asset.serialNumber ||
      asset.type,
  }));
}

/** Roles, searched by the API over title, code and department. */
export async function roleOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/roles', {
    params: {
      query: { search: term || undefined, status: 'active', limit: PICKER_LIMIT, offset: 0 },
    },
  });
  return (data?.data ?? []).map((role) => ({
    value: role.id,
    label: role.title,
    hint: role.code,
  }));
}

/** Courses somebody can still be enrolled on. Filtered CLIENT-SIDE: no `search` on the endpoint. */
export async function courseOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/training/courses', {
    params: { query: { includeRetired: false, limit: PICKER_LIMIT, offset: 0 } },
  });
  return (data?.data ?? [])
    .filter((course) => matches(term, course.title, course.code, course.category))
    .map((course) => ({
      value: course.id,
      label: course.title,
      hint: course.code,
    }));
}

/**
 * Controls, for linking one to a risk.
 *
 * Filtered CLIENT-SIDE: `/v1/controls` has no `search` either, and the Annex A catalogue is 93 controls
 * plus whatever an organisation adds — which fits one page today and is worth revisiting if a custom
 * catalogue grows past the limit. Retired controls are left out: a retired control cannot be the answer
 * to a live risk.
 */
export async function controlOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/controls', {
    params: { query: { includeRetired: false, limit: PICKER_LIMIT, offset: 0 } },
  });
  return (data?.data ?? [])
    .filter((control) => matches(term, control.title, control.reference, control.theme))
    .map((control) => ({
      value: control.id,
      label: control.title,
      hint: control.reference,
    }));
}

/**
 * Register risks, for recording which ones a supplier carries.
 *
 * SERVER-SIDE SEARCH over the reference, title and category. `search` was added to `/v1/risks` for this,
 * the same call made for `/v1/documents` and for the same reason: the risk register grows with every risk
 * an organisation records and has no natural ceiling, so the client-side compromise `controlOptions` makes
 * — justified there by Annex A being 93 controls — would silently stop finding things at the page limit.
 *
 * NO STATUS FILTER, and this one is worth stating because it is not obviously right. `/v1/risks` takes a
 * single `status`, so "everything except closed" is not expressible in one call, and `VendorService.linkRisk`
 * checks the risk's status not at all. Offering every risk therefore matches what the API will accept — and
 * the panel shows each linked risk's status, so a closed risk standing in for a live one is visible rather
 * than hidden behind a filter that quietly disagreed with the server.
 */
export async function riskOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/risks', {
    params: { query: { search: term || undefined, limit: PICKER_LIMIT, offset: 0 } },
  });
  return (data?.data ?? []).map((risk) => ({
    value: risk.id,
    label: risk.title,
    hint: risk.reference,
  }));
}

/**
 * Controlled documents, for pointing a record at the document that evidences it — an audit report, a
 * review's minutes.
 *
 * SERVER-SIDE SEARCH, unlike `controlOptions`. The documents register grows with every procedure, report and
 * set of minutes an organisation issues, so a client-side filter over one page would stop finding things
 * exactly when the register became useful. `search` was added to the API for this.
 *
 * Retired documents are excluded: a record cannot cite a document that has been withdrawn.
 */
export async function documentOptions(term: string): Promise<PickerOption[]> {
  const { data } = await api.GET('/v1/documents', {
    params: {
      query: {
        search: term || undefined,
        includeRetired: false,
        limit: PICKER_LIMIT,
        offset: 0,
      },
    },
  });
  return (data?.data ?? []).map((document) => ({
    value: document.id,
    label: document.title,
    hint: document.code,
  }));
}
