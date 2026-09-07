// Offset pagination is sourced from `@quynhonsemiconductor/platform-http` (the `offsetPagination`
// namespace) — the single source of truth shared across QNSC product backends.
//
// It is re-exported flat here so existing '@platform' consumers (controllers using
// `buildPageResult` / `ApiPagedResponse` / `PagedResult`) keep their import paths
// unchanged. opshub uses offset pagination; products needing cursor pagination use
// the sibling `cursorPagination` namespace from the same package.
import { offsetPagination } from '@quynhonsemiconductor/platform-http';

export const PageQuerySchema = offsetPagination.PageQuerySchema;
export const PageQueryDto = offsetPagination.PageQueryDto;
export const buildPageResult = offsetPagination.buildPageResult;
export const ApiPagedResponse = offsetPagination.ApiPagedResponse;

export type PageQuery = offsetPagination.PageQuery;
export type PageInfo = offsetPagination.PageInfo;
export type PagedResult<T> = offsetPagination.PagedResult<T>;
