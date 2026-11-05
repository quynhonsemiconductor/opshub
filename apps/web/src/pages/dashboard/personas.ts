import {
  AlertTriangle,
  BarChart2,
  CalendarClock,
  CheckCircle,
  DollarSign,
  Inbox,
  Laptop,
  ScanLine,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  UserCog,
  Users,
  Webhook,
} from 'lucide-react';
import type { GroupKey } from '@/shared/hooks/use-permissions';
import type { BadgeTone } from '@/shared/ui';
import type { DashboardIcon } from './dashboard-widgets';
import type { DashboardCounts } from './use-dashboard-counts';

/**
 * WHAT EACH PERSONA SEES, AS DATA.
 *
 * Seven persona dashboards used to be seven components, ~500 lines of JSX that differed only in
 * which tiles and links they listed. Every one re-typed the same `<StatTile … />` and
 * `<SectionCard><DomainLink … /></SectionCard>` shapes, which is why they had drifted: the same
 * destination carried three different subtitles across three personas, "Awaiting my approval" was
 * `variant="alert"` for four of the five that showed it, and two personas called a count hook whose
 * value they never rendered.
 *
 * As data, the differences are the only thing written down and the duplication has nowhere to hide.
 * A new persona is an entry, not a component.
 *
 * `count` names a key of `DashboardCounts` rather than holding a value, because a definition cannot
 * call a hook — the page resolves it. A tile with NO count is a navigation tile: it shows a dash and
 * exists to be clicked.
 */

export interface TileDef {
  label: string;
  to: string;
  icon: DashboardIcon;
  tone: BadgeTone;
  /** Which count fills it. Omit for a pure navigation tile. */
  count?: keyof DashboardCounts;
  /** Red ring when the number is above zero — for counts that mean somebody must act. */
  alert?: boolean;
}

export interface SectionDef {
  title: string;
  icon: DashboardIcon;
  links: { label: string; sub: string; to: string; icon: DashboardIcon; tone: BadgeTone }[];
}

export interface PersonaDef {
  tiles: TileDef[];
  sections: SectionDef[];
}

// ── Links every persona draws from, defined ONCE ──────────────────────────────
//
// The subtitle for a destination is a property OF THAT DESTINATION, not of whoever is looking at it.
// Three personas previously described `/compliance` three different ways.

const LINK = {
  assets: {
    label: 'Assets',
    sub: 'Hardware inventory and lifecycle',
    to: '/assets',
    icon: Laptop,
    tone: 'blue',
  },
  access: {
    label: 'Access Requests',
    sub: 'Privileged and temporary access',
    to: '/access',
    icon: ShieldCheck,
    tone: 'amber',
  },
  compliance: {
    label: 'Compliance',
    sub: 'Endpoint findings and drift',
    to: '/compliance',
    icon: ScanLine,
    tone: 'red',
  },
  requests: {
    label: 'Requests Inbox',
    sub: 'Items awaiting a decision',
    to: '/requests',
    icon: Inbox,
    tone: 'violet',
  },
  people: {
    label: 'People',
    sub: 'Employee directory and lifecycle',
    to: '/people',
    icon: Users,
    tone: 'blue',
  },
  workforce: {
    label: 'Workforce',
    sub: 'Leave, overtime and timesheets',
    to: '/workforce',
    icon: CalendarClock,
    tone: 'violet',
  },
  reports: {
    label: 'Reports',
    sub: 'Analytics and audit evidence',
    to: '/reports',
    icon: BarChart2,
    tone: 'green',
  },
  auditLogs: {
    label: 'Audit Logs',
    sub: 'Immutable event trail',
    to: '/settings/audit-logs',
    icon: ShieldAlert,
    tone: 'violet',
  },
  accessControl: {
    label: 'Access Control',
    sub: 'Groups, permissions and memberships',
    to: '/settings/access-control',
    icon: UserCog,
    tone: 'violet',
  },
  webhooks: {
    label: 'Webhooks',
    sub: 'Outbound event delivery',
    to: '/settings/webhooks',
    icon: Webhook,
    tone: 'blue',
  },
  finops: {
    label: 'FinOps',
    sub: 'Licence and cloud spend',
    to: '/finops',
    icon: DollarSign,
    tone: 'green',
  },
  catalog: {
    label: 'IT Catalog',
    sub: 'Request software and equipment',
    to: '/catalog',
    icon: Inbox,
    tone: 'blue',
  },
} as const satisfies Record<string, SectionDef['links'][number]>;

// ── Tiles ─────────────────────────────────────────────────────────────────────

const TILE = {
  assets: { label: 'Hardware assets', to: '/assets', icon: Laptop, tone: 'blue', count: 'assets' },
  myQueue: {
    label: 'Awaiting my approval',
    to: '/requests',
    icon: Inbox,
    tone: 'amber',
    count: 'myQueue',
    // Every persona that shows this one alerts on it: it is the number that means work is blocked.
    alert: true,
  },
  myRequests: {
    label: 'My open requests',
    to: '/requests',
    icon: Inbox,
    tone: 'amber',
    count: 'myQueue',
  },
  pendingAccess: {
    label: 'Pending access grants',
    to: '/access',
    icon: ShieldCheck,
    tone: 'violet',
    count: 'pendingAccess',
    alert: true,
  },
  openFindings: {
    label: 'Open compliance issues',
    to: '/compliance',
    icon: ScanLine,
    tone: 'red',
    count: 'openFindings',
    alert: true,
  },
  securityFindings: {
    label: 'Open compliance findings',
    to: '/compliance',
    icon: AlertTriangle,
    tone: 'red',
    count: 'openFindings',
    alert: true,
  },
  pendingLeave: {
    label: 'Pending leave',
    to: '/workforce',
    icon: CalendarClock,
    tone: 'violet',
    count: 'pendingLeave',
    alert: true,
  },
  directory: { label: 'Team directory', to: '/people', icon: Users, tone: 'blue' },
  myDevices: { label: 'My devices', to: '/assets', icon: Laptop, tone: 'blue' },
} as const satisfies Record<string, TileDef>;

// ── The personas ──────────────────────────────────────────────────────────────

/**
 * `helpdesk` deliberately shares the employee layout.
 *
 * It held no dashboard of its own before either — the page fell through to `EmployeeDashboard` for it
 * — and this makes that explicit rather than leaving it to a boolean in a render condition.
 */
export const PERSONAS: Record<GroupKey, PersonaDef> = {
  admin: {
    tiles: [TILE.assets, TILE.pendingAccess, TILE.openFindings, TILE.myQueue],
    sections: [
      {
        title: 'Platform Governance',
        icon: Settings2,
        links: [LINK.accessControl, LINK.auditLogs, LINK.webhooks, LINK.finops],
      },
      {
        title: 'Operations',
        icon: TrendingUp,
        links: [LINK.assets, LINK.access, LINK.compliance, LINK.requests],
      },
    ],
  },

  'it-admin': {
    tiles: [TILE.assets, TILE.myQueue, TILE.pendingAccess, TILE.openFindings],
    sections: [
      {
        title: 'IT Operations',
        icon: TrendingUp,
        links: [LINK.assets, LINK.access, LINK.compliance, LINK.requests],
      },
      {
        title: 'People & Workforce',
        icon: Users,
        links: [LINK.people, LINK.workforce, LINK.reports],
      },
    ],
  },

  security: {
    tiles: [TILE.securityFindings, { ...TILE.pendingAccess, tone: 'amber' }, TILE.directory],
    sections: [
      {
        title: 'Security Ops',
        icon: ShieldAlert,
        links: [LINK.compliance, LINK.access, LINK.auditLogs],
      },
      { title: 'Reports', icon: BarChart2, links: [LINK.reports, LINK.people] },
    ],
  },

  manager: {
    tiles: [TILE.myQueue, TILE.pendingLeave, TILE.directory],
    sections: [
      { title: 'Approvals', icon: CheckCircle, links: [LINK.requests, LINK.workforce] },
      { title: 'Team', icon: Users, links: [LINK.people, LINK.reports] },
    ],
  },

  approver: {
    tiles: [TILE.myQueue, TILE.pendingLeave],
    sections: [{ title: 'Approvals', icon: CheckCircle, links: [LINK.requests, LINK.workforce] }],
  },

  hr: {
    tiles: [
      { ...TILE.pendingLeave, label: 'Pending leave requests' },
      TILE.myQueue,
      TILE.directory,
    ],
    sections: [
      {
        title: 'Workforce',
        icon: CalendarClock,
        links: [LINK.workforce, LINK.people, LINK.reports],
      },
    ],
  },

  auditor: {
    // No tiles: an auditor reads evidence rather than working a queue, so a count they cannot act on
    // would be decoration.
    tiles: [],
    sections: [
      {
        title: 'Evidence & Audit',
        icon: ShieldAlert,
        links: [LINK.auditLogs, LINK.compliance, LINK.reports],
      },
      {
        title: 'Directory',
        icon: Users,
        links: [
          { ...LINK.people, sub: 'Employee directory (read-only)' },
          { ...LINK.assets, sub: 'Hardware inventory (read-only)' },
        ],
      },
    ],
  },

  employee: {
    tiles: [TILE.myRequests, TILE.myDevices],
    sections: [
      {
        title: 'Quick access',
        icon: TrendingUp,
        links: [
          { ...LINK.requests, sub: 'My submitted requests and status' },
          LINK.catalog,
          { ...LINK.workforce, sub: 'My leave, overtime and timesheets' },
          { ...LINK.assets, sub: 'The devices assigned to me' },
        ],
      },
    ],
  },

  helpdesk: {
    tiles: [TILE.myQueue, TILE.assets],
    sections: [
      { title: 'Service desk', icon: TrendingUp, links: [LINK.assets, LINK.access, LINK.requests] },
    ],
  },
};

/** Group → the label in the page title. */
export const GROUP_TITLE: Record<GroupKey, string> = {
  admin: 'Platform Admin',
  'it-admin': 'IT Admin',
  security: 'Security',
  manager: 'Manager',
  approver: 'Approver',
  hr: 'HR',
  auditor: 'Auditor',
  helpdesk: 'Helpdesk',
  employee: 'Employee',
};
