import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { isAuthenticated } from '@/shared/api/auth-store';
import { AppShell } from '@/widgets/app-shell/app-shell';
import { LoginPage } from '@/pages/login/login-page';
import { DashboardPage } from '@/pages/dashboard/dashboard-page';
import { AssetsPage } from '@/pages/assets/assets-page';
import { PeoplePage } from '@/pages/people/people-page';
import { PositionsPage } from '@/pages/positions/positions-page';
import { ContractsPage } from '@/pages/contracts/contracts-page';
import { TrainingPage } from '@/pages/training/training-page';
import { PerformancePage } from '@/pages/performance/performance-page';
import { RisksPage } from '@/pages/risks/risks-page';
import { ControlsPage } from '@/pages/controls/controls-page';
import { IncidentsPage } from '@/pages/incidents/incidents-page';
import { InformationAssetsPage } from '@/pages/information-assets/information-assets-page';
import { VendorsPage } from '@/pages/vendors/vendors-page';
import { NonconformancesPage } from '@/pages/quality/nonconformances-page';
import { CapasPage } from '@/pages/quality/capas-page';
import { AuditsPage } from '@/pages/quality/audits-page';
import { DocumentsPage } from '@/pages/documents/documents-page';
import { ReviewsPage } from '@/pages/quality/reviews-page';
import { AccessPage } from '@/pages/access/access-page';
import { CompliancePage } from '@/pages/compliance/compliance-page';
import { WorkforcePage } from '@/pages/workforce/workforce-page';
import { WebhooksPage } from '@/pages/settings/webhooks/webhooks-page';
import { RequestsPage } from '@/pages/requests/requests-page';
import { ReportsPage } from '@/pages/reports/reports-page';
import { RbacPage } from '@/pages/settings/rbac/rbac-page';
import { AuditLogsPage } from '@/pages/settings/audit-logs-page';
import { NotificationPreferencesPage } from '@/pages/notifications/notification-preferences-page';
import { ProfilePage } from '@/pages/profile/profile-page';
import { FinOpsPage } from '@/pages/finops/finops-page';
import { CatalogPage } from '@/pages/catalog/catalog-page';
import { SecurityPosturePage } from '@/pages/security-posture/security-posture-page';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/**
 * Sign-in route. Reached whenever there is no session — the shell guard redirects here
 * rather than bouncing straight to Entra, so the user sees where they are before a
 * cross-origin navigation takes over.
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

/** Authenticated layout shell. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
  beforeLoad: ({ location }) => {
    // The bootstrap has already run and resolved the session from the cookie (see
    // AppProviders), so this is a synchronous read — no request, no flicker.
    if (isAuthenticated()) return;

    // Carry the attempted path so the sign-in can return the user to it after Entra. The
    // server validates it against an open-redirect guard before honouring it.
    throw redirect({ to: '/login', search: { returnTo: location.href } });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: DashboardPage,
});

const assetsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/assets',
  component: AssetsPage,
});

const peopleRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/people',
  component: PeoplePage,
});

const positionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/positions',
  component: PositionsPage,
});

const contractsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/contracts',
  component: ContractsPage,
});

const trainingRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/training',
  component: TrainingPage,
});

const performanceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/performance',
  component: PerformancePage,
});

const risksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/risks',
  component: RisksPage,
});

const controlsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/controls',
  component: ControlsPage,
});

const incidentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/incidents',
  component: IncidentsPage,
});

const informationAssetsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/information-assets',
  component: InformationAssetsPage,
});

const vendorsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/vendors',
  component: VendorsPage,
});

const nonconformancesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/nonconformances',
  component: NonconformancesPage,
});

const capasRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/capas',
  component: CapasPage,
});

const documentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/documents',
  component: DocumentsPage,
});

const internalAuditsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/internal-audits',
  component: AuditsPage,
});

const managementReviewsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/management-reviews',
  component: ReviewsPage,
});

const accessRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/access',
  component: AccessPage,
});

const complianceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/compliance',
  component: CompliancePage,
});

const workforceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/workforce',
  component: WorkforcePage,
});

const webhooksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/webhooks',
  component: WebhooksPage,
});

const requestsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/requests',
  component: RequestsPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/reports',
  component: ReportsPage,
});

const rbacRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/access-control',
  component: RbacPage,
});

const auditLogsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/audit-logs',
  component: AuditLogsPage,
});

const notificationPreferencesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/notification-preferences',
  component: NotificationPreferencesPage,
});

const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/profile',
  component: ProfilePage,
});

const finopsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/finops',
  component: FinOpsPage,
});

const catalogRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/catalog',
  component: CatalogPage,
});

const securityPostureRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/security-posture',
  component: SecurityPosturePage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    dashboardRoute,
    assetsRoute,
    peopleRoute,
    positionsRoute,
    contractsRoute,
    trainingRoute,
    performanceRoute,
    risksRoute,
    controlsRoute,
    incidentsRoute,
    informationAssetsRoute,
    vendorsRoute,
    nonconformancesRoute,
    capasRoute,
    documentsRoute,
    internalAuditsRoute,
    managementReviewsRoute,
    accessRoute,
    complianceRoute,
    workforceRoute,
    requestsRoute,
    reportsRoute,
    webhooksRoute,
    rbacRoute,
    auditLogsRoute,
    notificationPreferencesRoute,
    profileRoute,
    finopsRoute,
    catalogRoute,
    securityPostureRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
