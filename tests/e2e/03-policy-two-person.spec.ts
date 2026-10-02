import { test, expect } from '@playwright/test';
import { openSandbox, goTo } from './helpers';

test.describe('Policy changes', () => {
  test('proposes a distribution change and approves it as a teammate', async ({ page }) => {
    await openSandbox(page);
    await goTo(page, '/funds/TWLF', /Tidewell/);
    // Open the fund to Luxembourg professional clients: ticking a class creates a draft preview.
    const luRow = page.locator('table.policy tbody tr').filter({ hasText: 'Luxembourg' });
    await expect(luRow).toBeVisible();
    const box = luRow.getByRole('checkbox').first();
    if (await box.isChecked()) await box.uncheck(); else await box.check();
    await expect(page.locator('.impact2')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Propose change' }).click();
    await expect(page.locator('.note', { hasText: /Proposed as pc_/ })).toBeVisible({ timeout: 30_000 });
    // The proposer cannot approve. The sandbox offers a switch to a teammate who can.
    const row = page.locator('tr').filter({ hasText: 'Awaiting approval' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Approve and publish' })).toBeDisabled();
    await expect(row).toContainText('You proposed this. Another person must approve it.');
    await row.getByRole('button', { name: /Switch to \w+ to approve/ }).click();
    await expect(page.locator('.acting')).toContainText('You are acting as', { timeout: 30_000 });
    // Now the approve button is live for the same draft.
    const row2 = page.locator('tr').filter({ hasText: 'Awaiting approval' }).first();
    const approve = row2.getByRole('button', { name: 'Approve and publish' });
    await expect(approve).toBeEnabled({ timeout: 30_000 });
    await approve.click();
    await expect(page.locator('tr').filter({ hasText: /Published by/ }).first()).toBeVisible({ timeout: 30_000 });
    // The fund now offers Luxembourg (or no longer does, if it was on to begin with).
    await goTo(page, '/policy-changes', 'Policy changes');
    await expect(page.locator('#app-main')).toContainText(/Published by/);
    // Audit log recorded both halves under different names.
    await goTo(page, '/audit', /Audit/);
    await expect(page.locator('#app-main')).toContainText(/policy\.proposed/, { timeout: 30_000 });
    await expect(page.locator('#app-main')).toContainText(/policy\.published/);
  });
});
