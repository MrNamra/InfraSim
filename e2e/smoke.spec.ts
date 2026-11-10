import { expect, test } from '@playwright/test';

test('editor shell renders, themes toggle, command palette & account modal work', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');

  await expect(page.getByTestId('topbar')).toBeVisible();
  await expect(page.getByTestId('palette-panel')).toBeVisible();
  await expect(page.getByTestId('canvas-panel')).toBeVisible();
  await expect(page.getByTestId('inspector-panel')).toBeVisible();
  await expect(page.getByTestId('bottom-dock')).toBeVisible();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).not.toBeVisible();

  await page.getByTestId('account-button').click();
  await expect(page.getByTestId('account-modal')).toBeVisible();
  await page.getByRole('button', { name: 'Close account modal' }).click();
  await expect(page.getByTestId('account-modal')).not.toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('user can register, reload session, sign out, and sign in against Laravel API', async ({
  page,
}) => {
  test.skip(!process.env.INFRASIM_E2E_WITH_API, 'Requires live API server on localhost:8000');

  const uniqueEmail = `playwright-${Date.now()}@example.com`;
  await page.goto('/');

  await page.getByTestId('account-button').click();
  const modal = page.getByTestId('account-modal');
  await modal.getByRole('button', { name: 'Register' }).click();
  await modal.getByPlaceholder('Ada Lovelace').fill('Ada Test');
  await modal.getByPlaceholder('ada@example.com').fill(uniqueEmail);
  await modal.getByPlaceholder('Minimum 8 characters').fill('password123');
  await modal.getByRole('button', { name: 'Create account' }).click();

  await expect(modal).not.toBeVisible();
  await expect(page.getByTestId('account-button')).toContainText('Ada Test');

  await page.reload();
  await expect(page.getByTestId('account-button')).toContainText('Ada Test');

  await page.getByTestId('account-button').click();
  await modal.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('account-button')).toContainText('Guest');

  await page.getByTestId('account-button').click();
  await modal.getByPlaceholder('ada@example.com').fill(uniqueEmail);
  await modal.getByPlaceholder('Minimum 8 characters').fill('password123');
  await modal.locator('button[type="submit"]').click();
  await expect(page.getByTestId('account-button')).toContainText('Ada Test');
});
