import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  PaginationFooter,
  RowActions,
  SegmentedControl,
  StatusBadge,
  TabToolbar,
  Tooltip,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { orDash } from '@/shared/lib/format';
import { CourseModal } from './course-modals';
import { useCourses } from './use-training';
import type { Course } from './training.types';

/**
 * The course catalogue.
 *
 * RETIRING IS NOT DELETING, and the filter says so. A retired course keeps every record and certificate
 * attached to it — an audit asks "was this person trained in 2024", and deleting the course would make
 * that unanswerable — so retirement only stops it being required or recorded again. The default view
 * hides retired courses because they are not choices any more; the toggle brings them back for exactly
 * the audit question above.
 *
 * READING THE CATALOGUE AND CHANGING IT ARE DIFFERENT CODES. Every route behind this tab's three write
 * controls — `POST /training/courses`, `PATCH /training/courses/{id}`, `POST /training/courses/{id}/retire`
 * — carries `@RequirePermission('training.manage')`, while the list itself needs only `training.read`.
 * `ROLE.MANAGER` and `ROLE.AUDITOR` hold the read code and not the manage code, so before this gate both
 * of them were shown New course, an Edit pencil on every row and a Retire button, and every one of them
 * answered 403. An auditor in particular was handed what looked like edit rights over the competency
 * catalogue an audit reads.
 */

const RETIRED_FILTERS = [
  { value: 'active', label: 'Available' },
  { value: 'all', label: 'Incl. retired' },
];

export function CoursesTab() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('training.manage');
  const [scope, setScope] = useState('active');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Course | null>(null);
  const [retiring, setRetiring] = useState<Course | null>(null);

  const courses = useCourses('', scope === 'all', list.limit, list.offset);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['training'] });

  async function retire() {
    if (!retiring) return;
    const { error } = await api.POST('/v1/training/courses/{id}/retire', {
      params: { path: { id: retiring.id } },
    });
    setRetiring(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to retire the course.'));
      return;
    }
    toast.success('Course retired');
    invalidate();
  }

  const columns: DataTableColumn<Course>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (course) => (
        <span className="font-mono text-xs font-medium text-fg">{course.code}</span>
      ),
    },
    {
      key: 'title',
      header: 'Course',
      cell: (course) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{course.title}</p>
          <p className="truncate text-xs text-fg-subtle">{orDash(course.provider)}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      cell: (course) => <Badge>{course.category}</Badge>,
      hideOnMobile: true,
    },
    {
      key: 'validity',
      header: 'Validity',
      align: 'right',
      // "Never expires" is a fact about the course, not a missing value, so it is words and not a dash.
      cell: (course) =>
        course.validityMonths == null ? (
          <span className="text-xs text-fg-subtle">Never expires</span>
        ) : (
          <span className="tabular-nums">{course.validityMonths} months</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (course) =>
        course.retiredAt ? (
          <StatusBadge tone="neutral">Retired</StatusBadge>
        ) : (
          <StatusBadge tone="green">Available</StatusBadge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // Nothing at all rather than disabled icons for a reader: two greyed buttons on every row of a
      // catalogue somebody is only reading is noise that never becomes actionable, and the reason is
      // already told once by the absent New course button rather than repeated per row.
      cell: (course) =>
        canManage ? (
          <RowActions>
            <Tooltip content="Edit">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${course.title}`}
                onClick={() => setEditing(course)}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </Tooltip>
            {/* Retiring is a one-way state transition, so it is offered only while there is a state to
                leave — an already-retired course has nothing this button could do. */}
            {!course.retiredAt && (
              <Tooltip content="Retire">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Retire ${course.title}`}
                  onClick={() => setRetiring(course)}
                >
                  <Archive className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <CourseModal
        editing={null}
        open={creating}
        onClose={() => setCreating(false)}
        onSuccess={invalidate}
      />
      {editing && (
        <CourseModal
          editing={editing}
          open
          onClose={() => setEditing(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!retiring}
        onCancel={() => setRetiring(null)}
        onConfirm={retire}
        title="Retire this course?"
        description="It can no longer be required by a position or recorded against anybody. Existing records and certificates are kept, because an audit asks what somebody was trained in at the time."
        confirmLabel="Retire course"
      />

      <TabToolbar
        filter={
          <SegmentedControl
            label="Filter by status"
            options={RETIRED_FILTERS}
            value={scope}
            onChange={(value) => {
              setScope(value);
              list.resetPaging();
            }}
          />
        }
        action={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New course
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={courses.data?.data}
        isLoading={courses.isLoading}
        isError={courses.isError}
        errorMessage="Failed to load courses."
        emptyMessage="No courses yet"
        emptyIcon={BookOpen}
        emptyAction={
          !canManage ? undefined : (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New course
            </Button>
          )
        }
      />

      <PaginationFooter
        pageInfo={courses.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="course"
      />
    </div>
  );
}
