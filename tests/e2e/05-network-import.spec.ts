import { test, expect } from '@playwright/test';
import { openSandbox, goTo, fill } from './helpers';

test.describe('Credential network', () => {
  test('imports a client from the network and the client consents', async ({ page, context }) => {
    await openSandbox(page);
    await goTo(page, '/network', 'Network');
    // Pick the first network client that is not yet imported and request consent.
    const use = page.getByRole('button', { name: 'Use this' }).first();
    await expect(use).toBeVisible({ timeout: 30_000 });
    const row = page.locator('tr').filter({ has: use });
    const clientName = (await row.locator('td').first().innerText()).trim().split('\n')[0];
    await use.click();
    const lzid = page.getByLabel('Network passport number');
    await expect(lzid).toHaveValue(/^LZ-/);
    await fill(page, page.getByLabel('Purpose, shown to the client'), 'Onboard for tokenized fund distribution');
    await page.getByRole('button', { name: 'Request consent' }).click();
    const reveal = page.locator('.reveal', { hasText: 'Consent requested for' });
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const consentUrl = (await reveal.locator('code').first().innerText()).trim();
    expect(consentUrl).toMatch(/consent\/?(\.html)?#/);
    // The client opens the consent page in a separate tab, signs with their name and approves.
    const consent = await context.newPage();
    await consent.goto(consentUrl);
    const sign = consent.locator('input.pt-sign');
    await expect(sign).toBeVisible({ timeout: 45_000 });
    await sign.fill(clientName.length >= 2 ? clientName : 'Authorized Signatory');
    await consent.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(consent.locator('.pt-alert.ok')).toContainText('Approved', { timeout: 30_000 });
    await consent.close();
    // Back in the distributor's app the share is active and the client is on the books.
    await page.reload();
    await expect(page.locator('.test-pill', { hasText: 'Test mode' })).toBeVisible({ timeout: 60_000 });
    await goTo(page, '/network', 'Network');
    await expect(page.locator('tr').filter({ hasText: clientName }).filter({ hasText: 'Imported' }).first()).toBeVisible({ timeout: 30_000 });
    await goTo(page, '/clients', /Clients/);
    await expect(page.getByRole('link', { name: clientName })).toBeVisible();
  });
});
