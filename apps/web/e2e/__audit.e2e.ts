import { test } from './support/test';
import { SHELL_ROUTES } from './support/routes';
import { gotoInShell } from './support/fixtures';

const DIR = '/home/nghiavt18/opshub-audit/shots';

for (const route of SHELL_ROUTES) {
  test(`audit ${route}`, async ({ page }) => {
    await gotoInShell(page, route);
    await page.waitForTimeout(2200);
    const name = route.replace(/\//g, '_') || '_root';
    await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });

    // Every tab on the page, so a tabbed screen is not judged by its first tab alone.
    const tabs = page.getByRole('tab');
    const count = await tabs.count();
    for (let i = 1; i < Math.min(count, 4); i++) {
      const label = (await tabs.nth(i).textContent())?.trim().replace(/\W+/g, '-') ?? `tab${i}`;
      await tabs.nth(i).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${DIR}/${name}__${label}.png`, fullPage: true });
    }
  });
}
