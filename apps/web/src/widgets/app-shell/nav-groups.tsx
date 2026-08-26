import type { ComponentType } from 'react';
import { FEATURES } from '@/shared/config/features';
import {
  LayoutDashboard,
  Laptop,
  ShieldCheck,
  ShieldHalf,
  ScanLine,
  AlertOctagon,
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardX,
  ClipboardList,
  CalendarCheck,
  ListChecks,
  Database,
  GraduationCap,
  Users,
  Briefcase,
  FileText,
  Webhook,
  Inbox,
  BarChart2,
  ShieldAlert,
  UserCog,
  BellRing,
  DollarSign,
  Package,
} from 'lucide-react';

/**
 * THE NAV, as data.
 *
 * Extracted from the shell because the shell crossed the 486-line ceiling the FE consistency ratchet
 * holds — and because this array is a set of PRODUCT DECISIONS about who each page is for, which is
 * worth reading and testing on its own. `app-shell.spec.tsx` asserts what a permission-less employee
 * sees from it; all eight browser-test seats are admins, so that tier has no browser coverage at all.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  /**
   * Backend permission key required to see this item (matches the keys in
   * db/seed.ts `PERMISSIONS`). Omit = always visible. The `'*'` wildcard held
   * by the `admin` role satisfies every gate via usePermissions().can().
   */
  cap?: string;
  /** Show an "Upgrade" badge when the feature is not available on current plan. */
  upgradeBadge?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Exported for `app-shell.spec.tsx`, which asserts WHICH entries a permission-less employee can see.
 *
 * Not merely a convenience: the gate on an entry is a product decision about who a page is for, and
 * `/access` was gated on `access_request.read` — a code `ROLE.EMPLOYEE` deliberately does not hold —
 * while every route behind the page is self-scoped or self-narrowing. A test over this array is the
 * cheapest place to catch that, since all eight browser seats are admins and see everything.
 */
export const navGroups: NavGroup[] = [
  {
    items: [{ to: '/', label: 'Overview', icon: LayoutDashboard }],
  },
  {
    label: 'Directory',
    items: [
      { to: '/people', label: 'People', icon: Users, cap: 'employee.read' },
      // `position.read` and `contract.read` are separate codes on purpose: who may see the org chart
      // and who may see engagements are different questions, and the auditor holds both while a
      // manager holds only the first.
      { to: '/positions', label: 'Positions', icon: Briefcase, cap: 'position.read' },
      { to: '/contracts', label: 'Contracts', icon: FileText, cap: 'contract.read' },
    ],
  },
  {
    label: 'IT Operations',
    items: [
      { to: '/assets', label: 'Assets', icon: Laptop, cap: 'asset.read' },
      /*
       * UNGATED, like the Inbox above it, and for the same reason: this page is self-service before it
       * is administrative.
       *
       * It was gated on `access_request.read`, which `ROLE.EMPLOYEE` deliberately does not hold — the
       * permission catalogue says so in as many words, because self-service access "is expressed by
       * the `self` SCOPE on a grant, not by a permission code". So the nav hid the page from the
       * majority of the organisation while the API would have served them: `POST /access-requests` is
       * `@SelfScoped`, `GET /access-requests` narrows to the caller when they lack the read code, and
       * `grants/me/active` is `@SelfScoped` too. An employee could neither raise a request nor see
       * what privileged access they already hold, on the flagship self-service journey.
       *
       * An approver's extra powers on the page are gated in the page, not by hiding the page.
       */
      { to: '/access', label: 'Access Requests', icon: ShieldCheck },
      { to: '/compliance', label: 'Compliance', icon: ScanLine, cap: 'compliance.read' },
      { to: '/requests', label: 'Inbox', icon: Inbox },
      // `license.read`, not `compliance.read`. Every route behind this page requires a licence code;
      // the mismatch is latent only because no seeded role holds one without the other, and
      // `license.service.ts` names the finance-shaped role that would break it.
      { to: '/finops', label: 'FinOps', icon: DollarSign, cap: 'license.read' },
      {
        to: '/security-posture',
        label: 'Security Posture',
        icon: ShieldHalf,
        cap: 'security.view',
        upgradeBadge: !FEATURES.SECURITY_POSTURE,
      },
    ],
  },
  {
    label: 'Self-Service',
    items: [{ to: '/catalog', label: 'IT Catalog', icon: Package }],
  },
  {
    label: 'Workforce',
    items: [
      { to: '/workforce', label: 'Workforce', icon: CalendarClock },
      // NO `cap`, deliberately, unlike Positions and Contracts: the screen's first tab is the
      // caller's OWN training, which is self-scoped and holds no permission code. Gating the nav
      // entry on `training.read` would hide an employee's own certificates from them.
      { to: '/training', label: 'Training', icon: GraduationCap },
      // Also uncapped: the first tab is the caller's own review, which is self-scoped. Gating this on
      // `performance.read` would hide an employee's own rating from them.
      { to: '/performance', label: 'Performance', icon: ClipboardCheck },
    ],
  },
  {
    // Its OWN group, above ISMS and Quality, because both cite it: an audit report, a review's minutes and a
    // control's evidence are all rows in this library. Filing it under either system would hide it from the
    // other.
    label: 'Documentation',
    items: [
      { to: '/documents', label: 'Controlled documents', icon: FileText, cap: 'documents.read' },
    ],
  },
  {
    // ISMS. Its own group rather than folded into IT Operations, where `/compliance` already means
    // endpoint findings — two different things called compliance in one list is how people click the
    // wrong one.
    label: 'Information Security',
    items: [
      { to: '/risks', label: 'Risk register', icon: ShieldAlert, cap: 'risk.read' },
      { to: '/controls', label: 'Controls & SoA', icon: ShieldCheck, cap: 'control.read' },
      // `incident.read` gates the LIST. Reporting needs no permission at all, which is why the report
      // action lives on the page rather than behind this entry.
      { to: '/incidents', label: 'Incidents', icon: AlertOctagon, cap: 'incident.read' },
      {
        to: '/information-assets',
        label: 'Information Assets',
        icon: Database,
        cap: 'information_asset.read',
      },
      { to: '/vendors', label: 'Suppliers', icon: Building2, cap: 'vendor.read' },
    ],
  },
  {
    // QMS. Separate from Information Security even though the two share the incident link: a quality
    // finding is against a REQUIREMENT and a security finding is against an asset, and one list holding
    // both is how a non-conformance gets triaged by the security rota.
    label: 'Quality',
    items: [
      // `nonconformance.read` gates the REGISTER. Raising a finding needs no permission at all — the same
      // reasoning as incident reporting — so that action lives on the page, not behind this entry.
      {
        to: '/nonconformances',
        label: 'Non-conformances',
        icon: ClipboardX,
        cap: 'nonconformance.read',
      },
      // The CAPA list is gated on `nonconformance.read` too, by the API: a corrective action is only
      // readable to somebody who may read the finding it answers.
      { to: '/capas', label: 'Corrective actions', icon: ListChecks, cap: 'nonconformance.read' },
      {
        to: '/internal-audits',
        label: 'Internal audits',
        icon: ClipboardList,
        cap: 'internal_audit.read',
      },
      {
        to: '/management-reviews',
        label: 'Management reviews',
        icon: CalendarCheck,
        cap: 'management_review.read',
      },
    ],
  },
  {
    label: 'Analytics',
    items: [{ to: '/reports', label: 'Reports', icon: BarChart2, cap: 'reports.read' }],
  },
  {
    label: 'Settings',
    items: [
      { to: '/settings/webhooks', label: 'Webhooks', icon: Webhook, cap: 'webhooks.manage' },
      { to: '/settings/access-control', label: 'Access Control', icon: UserCog, cap: 'rbac.read' },
      { to: '/settings/audit-logs', label: 'Audit Logs', icon: ShieldAlert, cap: 'audit.read' },
      { to: '/settings/notification-preferences', label: 'Notifications', icon: BellRing },
    ],
  },
];
