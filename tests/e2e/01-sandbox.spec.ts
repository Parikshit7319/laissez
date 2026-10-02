import { test, expect } from '@playwright/test';
import { openSandbox } from './helpers';

test.describe('Sandbox', () => {
  test('opens a sandbox with fictional data and three teammates', async ({ page }) => {
    await openSandbox(page);
    // The overview is the first view; the sidebar lists every group of the product.
    await expect(page.locator('#app-main h1').first()).toBeVisible();
    for (const label of ['Clients', 'New order', 'Decisions', 'Settlements', 'Funds', 'Policy changes', 'Network']) {
      await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
    }
    // Teammate switcher is present (sandbox only) and offers the three fictional colleagues.
    await page.getByRole('button', { name: /Acting as .*Change teammate/ }).click();
    const menu = page.getByRole('group', { name: 'Acting as' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button')).toHaveCount(4);
    await page.keyboard.press('Escape');
    // Clients view lists the fictional institutions with credentials.
    await page.evaluate(() => { location.hash = '#/clients'; });
    await expect(page.locator('#app-main h1').first()).toHaveText(/Clients/);
    await expect(page.getByRole('link', { name: 'Lumen Family Office Pte. Ltd.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Qamar Holdings Ltd' })).toBeVisible();
  });
});
