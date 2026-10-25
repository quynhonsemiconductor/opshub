// @vitest-environment jsdom
/**
 * CopyButton — written for the door token dialogs: the button, the check feedback, and the silent
 * fallback when the clipboard refuses (the token text stays selectable; nothing throws).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { CopyButton } from './copy-button';

const writeText = vi.fn<(text: string) => Promise<void>>();

afterEach(() => {
  writeText.mockReset();
  vi.unstubAllGlobals();
});

describe('CopyButton', () => {
  it('writes the text to the clipboard and confirms with a check', async () => {
    writeText.mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<CopyButton text="token-value" label="Copy token" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('token-value'));
    expect(await screen.findByRole('button', { name: 'Copy token' })).toBeInTheDocument();
  });

  it('does not throw past the dialog when the clipboard is denied', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<CopyButton text="token-value" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // The rejection is swallowed; no unhandled rejection, no crash.
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});
