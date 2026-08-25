/**
 * ProfilePage — "My Account" / personal settings for the current user.
 *
 * Sections:
 *   1. Identity summary (avatar initials, email, roles — read-only from JWT)
 *   2. Profile fields (displayName, jobTitle, department) — editable via
 *      PATCH /v1/employees/:id (requires fetching the employee record first)
 *   3. Sessions — active session count + sign out all sessions
 *   4. Authentication — SSO-only note; password change goes through Entra portal
 *
 * Pattern: fetch `/v1/auth/me` for JWT claims, then `/v1/employees/{id}` (where
 * id = me.sub) for the full employee record. `PATCH /v1/employees/{id}` for
 * profile edits (only fields the user can update; role changes are admin-only).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { User, Mail, Briefcase, Building2, ExternalLink, CheckCircle2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import {
  Badge,
  Button,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  StatusBadge,
  humanizeStatus,
  statusTone,
} from '@/shared/ui';
import { EM_DASH, formatDate } from '@/shared/lib/format';
import { MyContracts, MyRoleHistory } from './my-employment';
import type { components } from '@/shared/api/generated/api';

type EmployeeDto = components['schemas']['EmployeeResponseDto'];

// ── Shared UI ─────────────────────────────────────────────────────────────────

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-6 py-4">
        {/*
         * A HEADING, not a styled paragraph. Six sections on this page carried their titles as `<p>`, so a
         * screen reader was handed one flat run of text with no structure to navigate — and a browser test
         * could not address a section by name either. `h2` because the page's own title is the `h1`.
         */}
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}

function FieldRow({
  label,
  icon: Icon,
  value,
  placeholder,
}: {
  label: string;
  icon: React.ElementType;
  value: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
      <Icon className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
      <span className="w-28 shrink-0 text-xs font-medium text-fg-muted">{label}</span>
      <span className={`text-sm ${value ? 'text-fg' : 'text-fg-subtle italic'}`}>
        {value || placeholder || EM_DASH}
      </span>
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function AvatarInitials({ name, email }: { name: string; email: string }) {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  // Deterministic color from email hash
  const colors = [
    'bg-accent',
    'bg-violet-600',
    'bg-emerald-600',
    'bg-amber-600',
    'bg-rose-600',
    'bg-cyan-600',
  ];
  const idx = [...email].reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;

  return (
    <div
      className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full ${colors[idx]} text-xl font-semibold text-white select-none`}
    >
      {initials || '?'}
    </div>
  );
}

// ── Edit Profile Modal ────────────────────────────────────────────────────────

interface EditProfileModalProps {
  employee: EmployeeDto;
  onClose: () => void;
  onSuccess: (updated: EmployeeDto) => void;
}

function EditProfileModal({ employee, onClose, onSuccess }: EditProfileModalProps) {
  const [displayName, setDisplayName] = useState(employee.displayName);
  const [jobTitle, setJobTitle] = useState(employee.jobTitle ?? '');
  const [department, setDepartment] = useState(employee.department ?? '');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) {
      setErr('Display name is required.');
      return;
    }
    setLoading(true);
    setErr('');

    const { data, error } = await api.PATCH('/v1/employees/{id}', {
      params: { path: { id: employee.id } },
      body: {
        displayName: displayName.trim(),
        jobTitle: jobTitle.trim() || null,
        department: department.trim() || null,
      },
    });

    setLoading(false);
    if (error || !data) {
      /*
       * A 403 dressed as a transient failure. `PATCH /employees/:id` carries no scope descriptor, so
       * for the roles this page exists for the refusal is permanent — and "please try again" is
       * advice to repeat it forever.
       */
      setErr(apiErrorMessage(error, 'Failed to update your profile.'));
      return;
    }
    toast.success('Profile updated');
    onSuccess(data as EmployeeDto);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Edit profile">
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <FormField label="Display name" htmlFor="profile-name" required>
          <Input
            id="profile-name"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your full name"
          />
        </FormField>
        <FormField label="Job title" htmlFor="profile-title">
          <Input
            id="profile-title"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Senior Engineer"
          />
        </FormField>
        <FormField label="Department" htmlFor="profile-department">
          <Input
            id="profile-department"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="e.g. Engineering"
          />
        </FormField>

        <FormError message={err} />

        <FormActions loading={loading} onClose={onClose} submitLabel="Save changes" />
      </form>
    </Modal>
  );
}

function useEmployee(id: string | undefined) {
  return useQuery<EmployeeDto>({
    queryKey: ['employees', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/employees/{id}', {
        params: { path: { id: id! } },
      });
      if (error || !data) throw new Error('Failed to load employee record');
      return data as EmployeeDto;
    },
  });
}

// ── Role badge ────────────────────────────────────────────────────────────────

/*
 * NO ROLE OR STATUS COLOUR MAPS.
 *
 * `ROLE_LABELS` duplicated `ROLE_NAMES` from the permission catalogue, and the two colour maps
 * (`colors` inside `RoleBadge`, `statusColors` inside the page) each invented their own palette for
 * words the shared tone map already answers. `humanizeStatus` turns `it-admin` into `It-admin`, which
 * is wrong for a role key, so roles keep an explicit label — but their COLOUR is shared.
 */
const ROLE_LABEL: Record<string, string> = {
  admin: 'Platform Admin',
  'it-admin': 'IT Admin',
  security: 'Security',
  hr: 'HR',
  manager: 'Manager',
  auditor: 'Auditor',
  helpdesk: 'Helpdesk',
  employee: 'Employee',
};

/** The privileged roles read as violet; everything else is neutral. Colour is not the only signal. */
const PRIVILEGED = new Set(['admin', 'it-admin', 'security']);

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge tone={PRIVILEGED.has(role) ? 'violet' : 'neutral'}>{ROLE_LABEL[role] ?? role}</Badge>
  );
}

export function ProfilePage() {
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const { data: employee, isLoading: empLoading } = useEmployee(me?.sub);
  const [showEdit, setShowEdit] = useState(false);
  const [localEmployee, setLocalEmployee] = useState<EmployeeDto | null>(null);
  const [syncedEmployee, setSyncedEmployee] = useState<EmployeeDto | null | undefined>(employee);

  // Adjust local state during render when fresh server data arrives (React-
  // canonical alternative to a sync effect — no extra render pass).
  if (employee !== syncedEmployee) {
    setSyncedEmployee(employee);
    if (employee) setLocalEmployee(employee);
  }

  const displayEmployee = localEmployee ?? employee;
  const isLoading = meLoading || empLoading;

  function handleEditSuccess(updated: EmployeeDto) {
    setLocalEmployee(updated);
    qc.setQueryData(['employees', me?.sub], updated);
  }

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-surface-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-surface-muted" />
      </div>
    );
  }

  if (!me) return null;

  return (
    <>
      {showEdit && displayEmployee && (
        <EditProfileModal
          employee={displayEmployee}
          onClose={() => setShowEdit(false)}
          onSuccess={handleEditSuccess}
        />
      )}

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {/* Page header */}
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-fg">My Profile</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            View and update your personal details and account settings.
          </p>
        </div>

        {/* Identity card */}
        <div
          data-testid="identity-card"
          className="rounded-xl border border-border bg-surface px-6 py-5"
        >
          <div className="flex items-start gap-4">
            <AvatarInitials name={me.name} email={me.email} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-fg truncate">
                    {displayEmployee?.displayName ?? me.name}
                  </p>
                  <p className="text-sm text-fg-muted truncate">{me.email}</p>
                  {displayEmployee?.jobTitle && (
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {displayEmployee.jobTitle}
                      {displayEmployee.department ? ` · ${displayEmployee.department}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {displayEmployee?.status && (
                    <StatusBadge tone={statusTone(displayEmployee.status)}>
                      {humanizeStatus(displayEmployee.status)}
                    </StatusBadge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowEdit(true)}
                    className="gap-1.5"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Edit
                  </Button>
                </div>
              </div>
              {me.roles.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {me.roles.map((r) => (
                    <RoleBadge key={r} role={r} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Profile details */}
        {displayEmployee && (
          <SectionCard
            title="Profile details"
            subtitle="Information visible to your IT team and managers."
          >
            <div>
              <FieldRow label="Email" icon={Mail} value={displayEmployee.email} />
              <FieldRow label="Display name" icon={User} value={displayEmployee.displayName} />
              <FieldRow
                label="Job title"
                icon={Briefcase}
                value={displayEmployee.jobTitle ?? ''}
                placeholder="Not set"
              />
              <FieldRow
                label="Department"
                icon={Building2}
                value={displayEmployee.department ?? ''}
                placeholder="Not set"
              />
            </div>
          </SectionCard>
        )}

        {/* Your own employment record — both routes are self-scoped and neither had a caller, so an
            employee could not see their own role history or contract anywhere in the product. */}
        <SectionCard
          title="Your roles"
          subtitle="The positions you have held, newest first. Read from your own record."
        >
          <MyRoleHistory />
        </SectionCard>

        <SectionCard
          title="Your contracts"
          subtitle="Reference, type, dates and notice period — newest first."
        >
          <MyContracts />
        </SectionCard>

        {/* Authentication */}
        <SectionCard
          title="Authentication"
          subtitle="Your account uses Microsoft Entra ID (Azure AD) for sign-in."
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success mt-0.5" strokeWidth={1.75} />
            <div className="flex-1">
              <p className="text-sm font-medium text-fg">Single Sign-On via Microsoft Entra ID</p>
              <p className="mt-0.5 text-xs text-fg-muted">
                Your password and MFA settings are managed through your organisation's Microsoft
                account. To change your password or manage security options, visit the Microsoft My
                Account portal.
              </p>
              <a
                href="https://myaccount.microsoft.com/security-info"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent"
              >
                Manage Microsoft security settings
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </SectionCard>

        {/* Account info */}
        <SectionCard
          title="Account information"
          subtitle="System-generated fields. Contact IT admin to make changes."
        >
          <div className="space-y-0">
            <FieldRow label="User ID" icon={User} value={me.sub} />
            <FieldRow label="Account email" icon={Mail} value={me.email} />
            {displayEmployee && (
              <FieldRow
                label="Member since"
                icon={CheckCircle2}
                value={formatDate(displayEmployee.createdAt)}
              />
            )}
          </div>
        </SectionCard>
      </div>
    </>
  );
}
