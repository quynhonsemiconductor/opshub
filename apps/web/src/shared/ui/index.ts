/**
 * The UI kit, in one import path.
 *
 * Pages import from `@/shared/ui` rather than reaching for a file each: nine screens had grown their
 * own mix of deep imports, which is how three of them ended up NOT importing `Modal` and hand-rolling
 * a dialog instead — the primitive was there, it just was not where anybody was looking.
 *
 * Deliberately NOT a re-export of everything under `shared/`: hooks stay in `@/shared/hooks` and
 * formatting in `@/shared/lib/format`, because a barrel that also pulls in state and side effects
 * makes every page depend on every module.
 */
export { ActivityTimeline } from './activity-timeline';
export { Badge, type BadgeTone } from './badge';
export { Button, FOCUS_RING, type ButtonProps } from './button';
export { Card, CardContent, CardHeader, CardTitle } from './card';
export { ConfirmDialog } from './confirm-dialog';
export { DateRangePicker, type DateRange, type DateRangePickerProps } from './date-range-picker';
export { DataTable, type DataTableColumn, type DataTableProps } from './data-table';
export { DescriptionList, type DescriptionItem } from './description-list';
export { DurationInput, type DurationInputProps, type DurationPreset } from './duration-input';
export { EntityDetailPanel, type EntityDetailPanelProps } from './entity-detail-panel';
export { EntityPicker, type EntityPickerProps, type PickerOption } from './entity-picker';
export { FormField } from './form-field';
export { Input, type InputProps } from './input';
export { ListPage, type ListPageProps } from './list-page';
export { Modal, type ModalProps } from './modal';
export { PageHeader } from './page-header';
export { PaginationFooter, type PageInfo } from './pagination-footer';
export { FileUploadWidget } from './file-upload';
export { SegmentedControl, type SegmentedOption } from './segmented-control';
export { Select, type SelectProps } from './select';
export { SlideOver, SlideOverSection } from './slide-over';
export { StatCard, StatGrid } from './stat-card';
export { StatusBadge, type StatusBadgeProps } from './status-badge';
export {
  APPROVAL_TONE,
  LIFECYCLE_TONE,
  SEVERITY_TONE,
  humanizeStatus,
  statusTone,
} from './status-tone';
export { TabPanel, Tabs, type TabItem } from './tabs';
export {
  FormActions,
  FormError,
  IconAction,
  PanelAction,
  RowAction,
  RowActions,
  TabToolbar,
  type FormModalProps,
} from './tab-scaffold';
export { Textarea, type TextareaProps } from './textarea';
export { Tooltip, type TooltipProps } from './tooltip';
export { ThemeToggle } from './theme-toggle';
export { UpgradeGate } from './upgrade-gate';
export * from './checkbox';
export * from './panel-state';
export { DecisionNote } from './decision-note';
export { decisionNoteText, type CannotDecideReason } from './decision-reason';
