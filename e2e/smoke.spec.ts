import { test, expect } from '@playwright/test';

test('editor shell renders and command palette opens', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('topbar')).toBeVisible();
  await expect(page.getByTestId('palette-panel')).toBeVisible();
  await expect(page.getByTestId('canvas-panel')).toBeVisible();
  await expect(page.getByTestId('inspector-panel')).toBeVisible();
  await expect(page.getByTestId('bottom-dock')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
});
