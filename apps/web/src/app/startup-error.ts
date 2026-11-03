/**
 * The screen the SPA shows when it cannot start: `/config.json` missing or invalid, or the app chunk
 * itself failing to load.
 *
 * It is plain DOM on purpose: it runs BEFORE React, the stylesheet and the app chunk are loaded —
 * importing any of them is what the failed boot is not allowed to assume — and its job is simply to
 * replace the blank page with the reason. Values reach it through `textContent`, never HTML, because
 * the message quotes a server's answer.
 */
export const STARTUP_ERROR_TITLE = 'OpsHub could not start';

export const CONFIG_ERROR_DESCRIPTION =
  'The application configuration could not be loaded, so there is nothing to show.';
export const APP_ERROR_DESCRIPTION =
  'The application could not be loaded, so there is nothing to show.';

function line(doc: Document, tag: 'h1' | 'p' | 'pre', text: string): HTMLElement {
  const element = doc.createElement(tag);
  element.textContent = text;
  return element;
}

/**
 * Renders the error in `root`, replacing whatever is there, and renders a Reload button so a
 * transient failure (a rollout replacing config.json, a chunk fetched mid-deploy) costs one click.
 */
export function renderStartupError(root: HTMLElement, error: unknown, description: string): void {
  const doc = root.ownerDocument;
  const container = doc.createElement('div');
  container.setAttribute('role', 'alert');
  container.dataset.testid = 'startup-error';
  // System colours and no literal palette value: this runs before `globals.css`, so a design token
  // (`var(--…)`) would resolve to nothing, and a raw hex is what the design-token ratchet forbids.
  // `color-scheme` lets the browser pick readable foreground/background in light and dark.
  container.style.cssText =
    'color-scheme: light dark; max-width: 42rem; margin: 15vh auto; padding: 2rem; font-family: system-ui, sans-serif;';

  const message = error instanceof Error ? error.message : String(error);
  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText =
    'margin-top: 1rem; padding: 0.5rem 1rem; border: 1px solid currentColor; border-radius: 0.375rem; background: none; color: inherit; cursor: pointer; font: inherit;';
  reload.addEventListener('click', () => window.location.reload());

  container.append(
    line(doc, 'h1', STARTUP_ERROR_TITLE),
    line(doc, 'p', description),
    line(doc, 'pre', message),
    reload,
  );

  root.replaceChildren(container);
}
