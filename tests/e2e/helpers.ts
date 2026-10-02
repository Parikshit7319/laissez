// Shared steps for the browser tests. Every flow starts from a fresh sandbox opened through the real UI.
import { expect, type Page } from '@playwright/test';

export const APP = 'app/';

/** Opens the app, clicks "Open a sandbox" and waits for the shell. Returns once the sidebar is on screen. */
export async function openSandbox(page: Page): Promise<void> {
  await page.goto(APP);
  const button = page.getByRole('button', { name: 'Open a sandbox' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('.test-pill', { hasText: 'Test mode' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#app-main')).toBeVisible();
}

/** Navigates inside the app by hash route and waits for the view heading. */
export async function goTo(page: Page, route: string, heading?: string | RegExp): Promise<void> {
  await page.evaluate((r) => { location.hash = r; }, route.startsWith('#') ? route : `#${route}`);
  if (heading) await expect(page.locator('#app-main h1').first()).toHaveText(heading, { timeout: 30_000 });
}

/** Clears a text input and types a value, firing the input events the Preact forms listen to. */
export async function fill(page: Page, locator: ReturnType<Page['locator']>, value: string): Promise<void> {
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(value, { delay: 5 });
}

/** The "Acting as" switcher in the top bar. Picks a teammate by the start of their name. */
export async function actAs(page: Page, firstName: string): Promise<void> {
  await page.getByRole('button', { name: /Acting as .*Change teammate/ }).click();
  const menu = page.getByRole('group', { name: 'Acting as' });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: new RegExp(`^${firstName}`) }).click();
  await expect(page.locator('.acting', { hasText: `You are acting as` })).toContainText(firstName, { timeout: 30_000 });
}

export const ERROR_BOX = '.err, [role="alert"]';
