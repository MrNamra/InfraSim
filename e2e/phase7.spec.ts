import { expect, test } from '@playwright/test';

test.describe('Phase 7 — Polish & launch verification (T7.1 to T7.6)', () => {
  test('Docs route (/docs) renders simulation mechanics, estimated vs real, and glossary', async ({
    page,
  }) => {
    const response = await page.goto('/docs');
    expect(response?.status()).toBe(200);

    // Verify security headers
    const headers = response?.headers() || {};
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toContain("worker-src 'self' blob:");

    // Core content sections
    await expect(page.getByRole('heading', { name: 'How InfraSim Works' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '1. How the Simulator Works' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: "2. What's Estimated vs What's Real" }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '3. Architecture & Systems Glossary' }),
    ).toBeVisible();

    // Verify back link navigation
    await page.getByRole('link', { name: 'Back to Workbench' }).click();
    await expect(page).toHaveURL('/');
  });

  test('Privacy route (/privacy) renders local-first and WASM sandbox commitments', async ({
    page,
  }) => {
    const response = await page.goto('/privacy');
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole('heading', { name: 'Privacy Policy & Data Guarantees' }),
    ).toBeVisible();
    await expect(page.getByText('Local-first storage by default')).toBeVisible();
    await expect(page.getByText('Browser-isolated WebAssembly sandbox')).toBeVisible();
    await expect(page.getByText('Zero telemetry on proprietary designs')).toBeVisible();

    // Back to workbench
    await page.getByRole('link', { name: 'Back to Workbench' }).click();
    await expect(page).toHaveURL('/');
  });

  test('Workbench top bar Help button and Command Palette expose tour and docs links', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        'infrasim.tourCompleted',
        'true',
      );
    });

    await page.goto('/');

    // Help button in top bar
    const helpBtn = page.getByTestId('help-tour-btn');
    await expect(helpBtn).toBeVisible();
    await helpBtn.click();

    const tourModal = page.getByTestId('onboarding-tour-modal');
    await expect(tourModal).toBeVisible();
    await page.getByTestId('tour-close-btn').click();
    await expect(tourModal).not.toBeVisible();

    // Command palette via topbar button or Cmd/Ctrl+K
    const commandsBtn = page.getByTestId('topbar-commands-btn');
    if (await commandsBtn.isVisible()) {
      await commandsBtn.click();
    } else {
      await page.keyboard.press('ControlOrMeta+k');
    }
    const palette = page.getByTestId('command-palette-input');
    await expect(palette).toBeVisible();

    // Filter for Help
    await palette.fill('tour');
    await expect(page.getByText('Replay onboarding tour')).toBeVisible();
  });
});
