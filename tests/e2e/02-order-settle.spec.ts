import { test, expect } from '@playwright/test';
import { openSandbox, goTo } from './helpers';

test.describe('Orders', () => {
  test('places a subscription for Lumen in TWLF and settles it', async ({ page }) => {
    await openSandbox(page);
    await goTo(page, '/orders/new', 'New order');
    // Defaults: Lumen, TWLF, 2,000,000 USDC. The live preview must arrive before the button enables.
    await expect(page.getByLabel('Client')).toHaveValue('lumen');
    await expect(page.getByLabel('Fund')).toHaveValue('TWLF');
    const place = page.getByRole('button', { name: 'Place order' });
    await expect(place).toBeEnabled({ timeout: 45_000 });
    await expect(page.locator('#app-main')).toContainText(/ALLOW|Allowed|passes/i);
    await place.click();
    // Decision page with the signed receipt and the settle action.
    await expect(page.locator('#app-main h1').first()).toHaveText(/^Decision dec_/, { timeout: 45_000 });
    await expect(page.locator('#app-main')).toContainText('Lumen Family Office');
    const settle = page.getByRole('button', { name: 'Settle now' });
    await expect(settle).toBeVisible();
    await settle.click();
    // Simulated settlement returns settled at once; on-chain settlement polls until it settles.
    await expect(page.locator('#app-main')).toContainText(/Settlement stl_/, { timeout: 60_000 });
    await expect(page.locator('#app-main')).toContainText(/Settled|Settling on chain/, { timeout: 60_000 });
    await expect(page.locator('#app-main')).toContainText('Settled', { timeout: 120_000 });
    // The settlement appears in the list.
    await goTo(page, '/settlements', /Settlements/);
    await expect(page.locator('#app-main')).toContainText(/stl_/);
  });
});
