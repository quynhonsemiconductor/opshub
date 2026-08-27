/**
 * In-app notification template registry.
 * Each template maps a type key → (vars) → { title, body }.
 */

// ── Template names ────────────────────────────────────────────────────────────

/**
 * Every notification the system can render, and therefore every one it can send.
 *
 * A CONST FIRST, WITH THE TYPE DERIVED FROM IT — not the bare union this was. The union was
 * unenumerable at run time, so nothing could check the settings screen against it, and the screen
 * drifted badly: it offered 19 toggles of which 13 named an event that has no template at all and so
 * could never fire however it was set, while 9 templates that CAN fire had no toggle — including
 * `contract.expiring_soon`, `review.due` and `request.step_ready`, the ones people actually receive.
 * Every notification a user got was one they had no way to turn off.
 *
 * `notification-preference-contract.spec.ts` now pins the two together in both directions, and it can
 * only do that because this is a value. Adding a name here without a toggle fails that test, which is
 * the point: the settings screen is part of shipping a notification, not a thing to remember later.
 *
 * Ordered by domain rather than alphabetically so a reader can see which areas notify at all.
 *
 * `access_request.denied` WAS REMOVED rather than wired. It had a template, a variable shape, a
 * renderer and — after the settings screen was made truthful — a toggle, and no sender anywhere. It
 * was also redundant: every rejection already schedules `request.rejected` to the requester from
 * `RequestEngine.reject`, access requests included, and that one is delivered (15 approvals and 3
 * rejections on a seeded database). Wiring it would have sent two notifications for one event and
 * given the requester two switches for the same fact. A template nobody sends is not a feature
 * waiting to be finished; it is a claim the catalogue makes and cannot honour.
 */
export const NOTIFICATION_TEMPLATE_NAMES = [
  'access_request.submitted',
  'access_request.approved',
  'asset.assigned',
  'asset.unassigned',
  'employee.offboarded',
  'contract.expiring_soon',
  'contract.expired',
  'review.due',
  'request.sla_breach',
  'request.delegation_created',
  'request.step_ready',
  'request.submitted',
  'request.approved',
  'request.rejected',
] as const;

export type NotificationTemplateName = (typeof NOTIFICATION_TEMPLATE_NAMES)[number];

/** `*` is not a template — it is the global mute the preferences API accepts alongside a real type. */
export const GLOBAL_PREFERENCE_TYPE = '*';

// ── Per-template variable shapes ─────────────────────────────────────────────

export interface NotificationTemplateVars {
  'access_request.submitted': {
    resourceName: string;
    requesterName: string;
  };
  'access_request.approved': {
    resourceName: string;
    approverName: string;
  };
  'asset.assigned': {
    assetName: string;
    assetTag: string;
  };
  'asset.unassigned': {
    assetName: string;
    assetTag: string;
  };
  'employee.offboarded': {
    employeeName: string;
  };
  'contract.expiring_soon': {
    employeeName: string;
    reference: string;
    endDate: string; // YYYY-MM-DD
    daysRemaining: number;
  };
  'contract.expired': {
    employeeName: string;
    reference: string;
    endDate: string; // YYYY-MM-DD
  };
  /**
   * A periodic review that has come due — a risk, a control, an information asset, a supplier.
   *
   * ONE TEMPLATE FOR EVERY REGISTER, with `register` naming which one. The alternative was five
   * near-identical templates whose only difference was a noun, and five places to edit when the wording
   * changes. `daysOverdue` is the number that decides whether this is a nudge or a finding, so it is a
   * variable rather than something the reader works out from `dueOn`.
   */
  'review.due': {
    register: string;
    reference: string;
    name: string;
    dueOn: string; // YYYY-MM-DD
    daysOverdue: number;
  };
  'request.sla_breach': {
    requestType: string;
    requestId: string;
    deadline: string; // ISO string
  };
  'request.delegation_created': {
    delegatorName: string;
    endsAt: string; // ISO string
  };
  'request.step_ready': {
    requestType: string;
    requestId: string;
    completedStep: number;
    nextStep: number;
    totalSteps: number;
  };
  'request.submitted': {
    requestType: string;
    requestId: string;
    requesterEmail: string;
  };
  'request.approved': {
    requestType: string;
    requestId: string;
  };
  'request.rejected': {
    requestType: string;
    requestId: string;
    reason?: string;
  };
}

export interface RenderedNotification {
  title: string;
  body: string;
}

// ── Template implementations ──────────────────────────────────────────────────

const templates: {
  [K in NotificationTemplateName]: (v: NotificationTemplateVars[K]) => RenderedNotification;
} = {
  'access_request.submitted'(v) {
    return {
      title: 'Access request submitted',
      body: `Your request for access to "${v.resourceName}" is pending approval.`,
    };
  },
  'access_request.approved'(v) {
    return {
      title: 'Access request approved ✓',
      body: `${v.approverName} approved your request for "${v.resourceName}".`,
    };
  },
  'asset.assigned'(v) {
    return {
      title: 'Asset assigned to you',
      body: `${v.assetName} (${v.assetTag}) has been assigned to you.`,
    };
  },
  'asset.unassigned'(v) {
    return {
      title: 'Asset unassigned',
      body: `${v.assetName} (${v.assetTag}) has been unassigned from you.`,
    };
  },
  'employee.offboarded'(v) {
    return {
      title: 'Offboarding complete',
      body: `The offboarding process for ${v.employeeName} has been completed.`,
    };
  },
  'contract.expiring_soon'(v) {
    return {
      title: 'Contract expiring soon',
      body: `${v.employeeName}'s contract ${v.reference} ends on ${v.endDate} — ${v.daysRemaining} day(s) away. Renew or terminate it before then.`,
    };
  },
  'contract.expired'(v) {
    return {
      title: 'Contract expired',
      body: `${v.employeeName}'s contract ${v.reference} reached its end date of ${v.endDate} and is now marked expired.`,
    };
  },
  'review.due'(v) {
    return {
      title: `${v.register} review due`,
      body:
        `${v.reference} — ${v.name} was due for review on ${v.dueOn}` +
        (v.daysOverdue > 0
          ? `, ${v.daysOverdue} day(s) ago. Review it or re-date it.`
          : ` (today). Review it or re-date it.`),
    };
  },
  'request.sla_breach'(v) {
    return {
      title: 'SLA breach warning',
      body: `Your ${v.requestType} request (${v.requestId}) has exceeded its SLA deadline of ${v.deadline}. Please take action.`,
    };
  },
  'request.delegation_created'(v) {
    return {
      title: 'Approval delegation received',
      body: `${v.delegatorName} has delegated their approval authority to you until ${v.endsAt}.`,
    };
  },
  'request.step_ready'(v) {
    return {
      title: `Action required: ${v.requestType} approval (step ${v.nextStep}/${v.totalSteps})`,
      body: `Step ${v.completedStep} has been approved. Your review is now required (step ${v.nextStep} of ${v.totalSteps}).`,
    };
  },
  'request.submitted'(v) {
    return {
      title: `New ${v.requestType} request awaiting review`,
      body: `${v.requesterEmail} submitted a ${v.requestType} request (${v.requestId}) that requires your approval.`,
    };
  },
  'request.approved'(v) {
    return {
      title: `Your ${v.requestType} request was approved`,
      body: `Your ${v.requestType} request (${v.requestId}) has been approved.`,
    };
  },
  'request.rejected'(v) {
    const extra = v.reason ? ` Reason: ${v.reason}` : '';
    return {
      title: `Your ${v.requestType} request was rejected`,
      body: `Your ${v.requestType} request (${v.requestId}) has been rejected.${extra}`,
    };
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

export function renderNotification<K extends NotificationTemplateName>(
  type: K,
  vars: NotificationTemplateVars[K],
): RenderedNotification {
  const fn = templates[type];
  return (fn as (v: NotificationTemplateVars[K]) => RenderedNotification)(vars);
}
