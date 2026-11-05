// @vitest-environment jsdom
/**
 * PaginationFooter — the arithmetic, and the two buttons that must not produce an invalid request.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaginationFooter } from './pagination-footer';

describe('PaginationFooter', () => {
  it('renders nothing without pageInfo, and nothing for an empty list', () => {
    const { container: a } = render(
      <PaginationFooter pageInfo={undefined} onOffsetChange={vi.fn()} />,
    );
    expect(a).toBeEmptyDOMElement();

    const { container: b } = render(
      <PaginationFooter
        pageInfo={{ total: 0, limit: 25, offset: 0, hasNextPage: false }}
        onOffsetChange={vi.fn()}
      />,
    );
    expect(b).toBeEmptyDOMElement();
  });

  it('shows a plain count with NO buttons when everything fits on one page', () => {
    // A pager under a five-row table is furniture.
    render(
      <PaginationFooter
        pageInfo={{ total: 5, limit: 25, offset: 0, hasNextPage: false }}
        onOffsetChange={vi.fn()}
        noun="roles"
      />,
    );
    expect(screen.getByText(/5 roles results/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the range of THIS page, not the window that was asked for', () => {
    // The final page is short: `offset + limit` would claim rows that do not exist.
    render(
      <PaginationFooter
        pageInfo={{ total: 312, limit: 25, offset: 300, hasNextPage: false }}
        onOffsetChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/301–312 of 312/)).toBeInTheDocument();
  });

  it('disables Previous on the first page and Next on the last', () => {
    render(
      <PaginationFooter
        pageInfo={{ total: 60, limit: 25, offset: 0, hasNextPage: true }}
        onOffsetChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
  });

  it('steps by the page size in both directions', () => {
    const onOffsetChange = vi.fn();
    render(
      <PaginationFooter
        pageInfo={{ total: 60, limit: 25, offset: 25, hasNextPage: true }}
        onOffsetChange={onOffsetChange}
      />,
    );

    screen.getByRole('button', { name: /Next/ }).click();
    expect(onOffsetChange).toHaveBeenLastCalledWith(50);

    screen.getByRole('button', { name: /Previous/ }).click();
    expect(onOffsetChange).toHaveBeenLastCalledWith(0);
  });

  it('never asks for a negative offset', () => {
    // The API answers a negative offset with a 422, so the arithmetic is clamped rather than
    // trusted — an offset that is not a multiple of the limit is a real state after a page-size
    // change.
    const onOffsetChange = vi.fn();
    render(
      <PaginationFooter
        pageInfo={{ total: 60, limit: 25, offset: 10, hasNextPage: true }}
        onOffsetChange={onOffsetChange}
      />,
    );
    screen.getByRole('button', { name: /Previous/ }).click();
    expect(onOffsetChange).toHaveBeenLastCalledWith(0);
  });
});
