import { test, expect } from '@playwright/test';
import { openSandbox, goTo, fill } from './helpers';

test.describe('Credentials', () => {
  test('issues a Laissez-passer for Lumen with an accredited investor classification', async ({ page }) => {
    await openSandbox(page);
    await goTo(page, '/clients/lumen', /Lumen Family Office/);
    await page.getByRole('button', { name: /(Issue|Renew) credential/ }).click();
    await expect(page.locator('#app-main h1').first()).toHaveText(/(Issue|Renew) credential/);
    // 1. Choose the Singapore accredited investor test.
    const pick = page.locator('.pick-i').filter({ hasText: /Accredited investor/ }).first();
    await pick.getByRole('checkbox').check();
    // 2. Evidence: net assets above S$10M and the opt-in, plus a reference.
    const netAssets = page.getByLabel(/Net assets/).first();
    await fill(page, netAssets, '62500000');
    const optIn = page.locator('label.check', { hasText: 'Yes' }).getByRole('checkbox').first();
    await optIn.check();
    await fill(page, page.getByLabel('Evidence reference'), 'KYC-2026-0412, audited accounts FY2025');
    await expect(page.locator('#app-main')).toContainText(/exceed S\$10M/);
    // 3. Issue.
    const issue = page.getByRole('button', { name: 'Issue Laissez-passer' });
    await expect(issue).toBeEnabled();
    await issue.click();
    await expect(page.locator('#app-main h1').first()).toHaveText(/Lumen Family Office/, { timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'Renew credential' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke credential' })).toBeVisible();
    await expect(page.locator('#app-main')).toContainText(/LZ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });
});
