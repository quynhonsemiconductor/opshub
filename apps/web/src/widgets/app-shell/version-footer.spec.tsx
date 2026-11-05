// @vitest-environment jsdom
/**
 * VersionFooter — the line the owner asked for: the running version, with both images named when a
 * half-rolled deploy has left them different, and only what is known when the chart injected nothing.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV } from '@/shared/config/env';
import { useApiMeta } from '@/shared/hooks/use-api-meta';
import { formatVersionLine } from './version-line';
import { VersionFooter } from './version-footer';

vi.mock('@/shared/hooks/use-api-meta', () => ({ useApiMeta: vi.fn() }));

const meta = vi.mocked(useApiMeta);

/** The hook's return is a TanStack result; the component reads only `data`. */
function apiReturns(data: { version: string; commit: string | null; env: string } | undefined) {
  meta.mockReturnValue({ data } as ReturnType<typeof useApiMeta>);
}

beforeEach(() => {
  ENV.APP_VERSION = undefined;
  ENV.APP_COMMIT = undefined;
});

afterEach(() => {
  meta.mockReset();
});

describe('formatVersionLine', () => {
  it('shows ONE version when web and API are the same image', () => {
    expect(formatVersionLine('v0.8.9', 'v0.8.9', 'prod')).toBe('v0.8.9 · prod');
  });

  it('names BOTH when a half-rolled deploy has the two images apart', () => {
    expect(formatVersionLine('v0.8.9', 'v0.8.10', 'dev')).toBe('Web v0.8.9 · API v0.8.10 · dev');
  });

  it('shows what it knows while the other half is unknown', () => {
    expect(formatVersionLine('v0.8.9', undefined, 'prod')).toBe('v0.8.9 · prod');
    expect(formatVersionLine(undefined, 'v0.8.9', 'prod')).toBe('v0.8.9 · prod');
  });

  it('shows nothing at all when nothing is known', () => {
    expect(formatVersionLine(undefined, undefined, undefined)).toBeNull();
  });
});

describe('VersionFooter', () => {
  it('renders the web and API versions plus the environment', () => {
    ENV.APP_VERSION = 'v0.8.9';
    apiReturns({ version: 'v0.8.10', commit: 'abc1234def56', env: 'dev' });

    render(<VersionFooter />);

    expect(screen.getByText('Web v0.8.9 · API v0.8.10 · dev')).toBeInTheDocument();
  });

  it('puts each image commit in the hover title, and invents none where the tag names no commit', () => {
    ENV.APP_VERSION = 'sha-0123456789ab';
    ENV.APP_COMMIT = '0123456789ab';
    apiReturns({ version: 'v0.8.9', commit: null, env: 'prod' });

    render(<VersionFooter />);

    expect(
      screen.getByTitle('Web sha-0123456789ab (0123456789ab) · API v0.8.9'),
    ).toBeInTheDocument();
  });

  it('renders nothing when the web tag is absent and the API has not answered', () => {
    apiReturns(undefined);

    const { container } = render(<VersionFooter />);

    expect(container).toBeEmptyDOMElement();
  });
});
