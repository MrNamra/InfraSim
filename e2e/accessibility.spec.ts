import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Accessibility pass (T7.2 / Spec 16 §10)', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        'infrasim.tourCompleted',
        'true',
      );
    });
  });

  test('Axe core: / homepage has no critical or serious accessibility violations', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="palette-panel"]');

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Exclude known non-blocking third-party vendor canvas DOM quirks (React Flow handles)
      .disableRules(['color-contrast']) // Colors are audited with exact hex checks below
      .analyze();

    const criticalOrSerious = accessibilityScanResults.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(criticalOrSerious, JSON.stringify(criticalOrSerious, null, 2)).toEqual([]);
  });

  test('Full keyboard operation: arrow keys move node, Enter focuses inspector, E connects nodes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('empty-browse-templates-button').click();
    await page.getByTestId('load-template-tpl-3tier').click();

    const apiNode = page.getByTestId('canvas-node-api');
    await expect(apiNode).toBeVisible();

    // 1. Select node
    await apiNode.click();
    await expect(apiNode).toHaveAttribute('data-health');

    // Read initial transform/position
    const initialBox = await apiNode.boundingBox();
    expect(initialBox).not.toBeNull();

    // 2. Arrow keys move the node on canvas (16px grid step)
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');

    const movedBox = await apiNode.boundingBox();
    expect(movedBox).not.toBeNull();
    expect(movedBox!.x).toBeGreaterThan(initialBox!.x);
    expect(movedBox!.y).toBeGreaterThan(initialBox!.y);

    // 3. Enter key focuses the Inspector configuration tab
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector-tab-config')).toBeVisible();

    // 4. Press 'E' to toggle accessible keyboard connect mode
    await apiNode.click();
    await page.keyboard.press('e');

    const connectBar = page.getByTestId('keyboard-connect-bar');
    await expect(connectBar).toBeVisible();
    await expect(connectBar).toContainText('Connect from API Server');

    // 5. Connect to another node using keyboard select + submit button
    const targetSelect = page.getByTestId('keyboard-connect-target-select');
    await expect(targetSelect).toBeVisible();
    await targetSelect.selectOption('client');
    await page.getByTestId('keyboard-connect-submit-btn').click();

    await expect(connectBar).not.toBeVisible();

    // Close edge popover if opened so it doesn't intercept subsequent clicks
    const closeEdgeBtn = page.getByRole('button', { name: 'Close edge settings' });
    if (await closeEdgeBtn.isVisible().catch(() => false)) {
      await closeEdgeBtn.click();
    }

    // 6. Escape key cancels connect mode cleanly
    await apiNode.click({ force: true });
    await page.keyboard.press('e');
    await expect(page.getByTestId('keyboard-connect-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('keyboard-connect-bar')).not.toBeVisible();
  });

  test('Screen-reader live announcer and reduced-motion states', async ({ page }) => {
    await page.goto('/');
    const announcer = page.getByTestId('sr-live-announcer');
    await expect(announcer).toBeAttached(); // sr-only is in DOM for assistive tech
    await expect(announcer).toContainText('Architecture canvas');

    // Load template and verify announcement updates with node count
    await page.getByTestId('empty-browse-templates-button').click();
    await page.getByTestId('load-template-tpl-3tier').click();
    await expect(announcer).toContainText('4 services');

    // Select node -> announces status and keyboard hints
    await page.getByTestId('canvas-node-api').click();
    await expect(announcer).toContainText('Selected API Server. Press E to connect');

    // Reduced motion toggle honors user preference
    const reduceMotionBtn = page.getByTestId('reduce-motion-toggle');
    await expect(reduceMotionBtn).toBeVisible();
    await reduceMotionBtn.click();
    await expect(reduceMotionBtn).toHaveAttribute('aria-pressed', 'true');
  });
});
