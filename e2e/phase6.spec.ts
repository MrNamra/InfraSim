import { expect, test } from '@playwright/test';

test('Phase 6 E2E: insights DAG & fixes, A/B run comparison, AI summary preview, cost-vs-latency sweep, Challenge Mode & mobile read-only share', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');

  // 1. Load 3-tier spike template and run simulation -> Insights dock & Why? DAG
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-3tier').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 20_000 });

  // Pin Run A for A/B comparison
  await page.getByTestId('pin-run-a-btn').click();
  await expect(page.getByTestId('ab-comparison-bar')).toBeVisible();

  // Check Insights dock tab + filter
  await page.getByTestId('dock-tab-insights').click();
  const insightsDock = page.getByTestId('insights-dock-tab');
  await expect(insightsDock).toBeVisible();
  await expect(insightsDock.locator('[data-testid^="dock-insight-"]').first()).toBeVisible();

  // Inspect overloaded API node Why? tab -> AI preview disclosure + Apply fix + Re-run
  await page.getByTestId('canvas-node-api').click({ force: true });
  await page.getByTestId('inspector-tab-why').click();
  const whyTab = page.getByTestId('inspector-why-tab');
  await expect(whyTab).toBeVisible();

  // Optional AI explainer payload preview (EXPLAIN_ENABLED=false) never contains code/env/fixtures
  await page.getByTestId('why-rephrase-toggle').click();
  const payloadPreview = page.getByTestId('explain-payload-preview');
  await expect(payloadPreview).toBeVisible();
  const previewText = await payloadPreview.innerText();
  expect(previewText).toContain('"designName"');
  expect(previewText).not.toContain('"scripts"');
  expect(previewText).not.toContain('"mockEnv"');
  expect(previewText).not.toContain('"fixtures"');

  // Apply first fix on Why? tab and verify re-run produces Run A vs Run B delta
  const firstFixBtn = whyTab.locator('[data-testid^="apply-fix-"]').first();
  await expect(firstFixBtn).toBeVisible();
  await firstFixBtn.click();
  await expect(page.getByTestId('applied-fix-banner')).toBeVisible();
  await page.getByTestId('rerun-verify-btn').click();

  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('ab-comparison-bar')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('ab-comparison-bar')).toContainText('→');

  // 2. Cost vs latency Pareto sweep in Cost dock
  await page.getByTestId('dock-tab-cost').click();
  await expect(page.getByTestId('cost-dock-tab')).toBeVisible();
  await page.getByTestId('cost-subtab-sweep').click();
  await expect(page.getByTestId('cost-sweep-view')).toBeVisible();
  await page.getByTestId('cost-run-sweep-btn').click();
  await expect(page.getByTestId('cost-sweep-chart')).toBeVisible({ timeout: 20_000 });
  const applySweepBtn = page.getByTestId('cost-sweep-apply-btn');
  await expect(applySweepBtn).toBeVisible();
  if (await applySweepBtn.isEnabled()) {
    await applySweepBtn.click();
  }

  // 3. Challenge Mode -> start "First Blood" -> verify banner constraints -> run & check
  await page.getByTestId('open-challenges-button').click();
  await expect(page.getByTestId('challenges-modal')).toBeVisible();
  await page.getByTestId('start-challenge-first-blood').click();
  await expect(page.getByTestId('challenges-modal')).not.toBeVisible();
  await expect(page.getByTestId('challenge-banner')).toBeVisible();
  await expect(page.getByTestId('challenge-constraints-list')).toBeVisible();

  await page.getByTestId('challenge-verify-btn').click();
  await expect(page.getByTestId('challenge-attempts-badge')).toContainText('1', {
    timeout: 20_000,
  });

  // 4. Share Modal -> generate portable read-only #d= URL -> verify on mobile viewport (375x812)
  await page.getByTestId('topbar-share-btn').click();
  await expect(page.getByTestId('share-versions-modal')).toBeVisible();
  const shareUrl = await page.getByTestId('share-url-input').inputValue();
  expect(shareUrl).toContain('/shared/inline#d=');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(shareUrl);
  await expect(page.getByTestId('shared-viewer-root')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('shared-readonly-badge')).toContainText('Read-only');

  // Verify zero horizontal overflow on 375px mobile screen
  const overflowPx = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document;
    return doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  });
  expect(overflowPx).toBeLessThanOrEqual(0);

  // Switch to Nodes & details mobile tab cleanly and inspect read-only summary
  await page.getByTestId('mobile-tab-summary').click();
  await expect(page.getByTestId('shared-summary-panel')).toBeVisible();
  await expect(page.getByTestId('shared-node-inspector')).toBeVisible();
  await expect(page.getByTestId('run-sim-button')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
