import { expect, test } from '@playwright/test';

test('Phase 1 E2E: starter templates, spike red/shake, reduced motion, Why? fix, Latency & Mock, Metrics charts, and missing client prompt', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const failedIconRequests: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.url().includes('/icons/services/') && res.status() >= 400) {
      failedIconRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  await page.goto('/');

  // 0. Verify per-service SVG icons load cleanly in Palette tabs (AWS, GCP, Azure, OCI) while Generic keeps Lucide vector fallback
  const palette = page.getByTestId('palette-panel');
  const assertImgLoaded = async (locator: ReturnType<typeof page.locator>) => {
    await expect(locator).toBeVisible();
    const ok = await locator.evaluate((el) => {
      const img = el as unknown as { complete: boolean; naturalWidth: number };
      return Boolean(img.complete && img.naturalWidth > 0);
    });
    expect(ok).toBe(true);
  };

  for (const [tabName, serviceId] of [
    ['AWS', 'aws.ec2'],
    ['GCP', 'gcp.cloud_run'],
    ['Azure', 'azure.cosmos_db'],
    ['OCI', 'oci.compute'],
  ] as const) {
    await palette.getByRole('tab', { name: tabName, exact: true }).click();
    await assertImgLoaded(page.getByTestId(`palette-item-${serviceId}`).locator('img'));
  }

  await palette.getByRole('tab', { name: 'Generic', exact: true }).click();
  await expect(
    page.getByTestId('palette-item-generic.client').locator('svg').first(),
  ).toBeVisible();
  await expect(page.getByTestId('palette-item-generic.client').locator('img')).toHaveCount(0);
  await palette.getByRole('tab', { name: 'All', exact: true }).click();

  // 1. Open blank canvas -> Browse starter templates -> load Simple 3-tier web app
  await expect(page.getByTestId('empty-browse-templates-button')).toBeVisible();
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-3tier').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  const apiNode = page.getByTestId('canvas-node-api');
  await expect(apiNode).toBeVisible();
  await expect(page.getByTestId('canvas-node-db')).toBeVisible();
  await assertImgLoaded(apiNode.locator('img'));
  await assertImgLoaded(page.getByTestId('canvas-node-db').locator('img'));
  await expect(page.getByTestId('canvas-node-client').locator('svg').first()).toBeVisible();

  // 2. Run spike scenario -> API turns red/overloaded + shakes
  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });
  await expect(apiNode).toHaveAttribute('data-health', 'overloaded');
  await expect(apiNode).toHaveClass(/infrasim-shake/);
  // Never color-only: sr-only/text status & non-color cue present
  await expect(apiNode).toContainText(/Overloaded/i);

  // 3. Reduced motion fallback via manual toggle AND OS media preference
  await page.getByTestId('reduce-motion-toggle').click();
  await expect(apiNode).toHaveClass(/infrasim-pulse-overloaded/);
  await expect(apiNode).not.toHaveClass(/infrasim-shake/);
  await expect(apiNode).toHaveAttribute('data-health', 'overloaded');

  await page.getByTestId('reduce-motion-toggle').click();
  await expect(apiNode).toHaveClass(/infrasim-shake/);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(apiNode).toHaveClass(/infrasim-pulse-overloaded/);
  await expect(apiNode).not.toHaveClass(/infrasim-shake/);
  await page.emulateMedia({ reducedMotion: null });

  // 4. Select overloaded API node -> Why? tab opens immediately with fix -> apply & re-run
  await apiNode.click({ force: true });
  await expect(page.getByTestId('inspector-why-tab')).toBeVisible({ timeout: 300 });
  const firstApplyFixBtn = page
    .getByTestId('inspector-why-tab')
    .locator('[data-testid^="apply-fix-"]')
    .first();
  await expect(firstApplyFixBtn).toBeVisible();
  await firstApplyFixBtn.click();

  await expect(page.getByTestId('applied-fix-banner')).toBeVisible();
  await page.getByTestId('rerun-verify-btn').click();
  await expect(page.getByTestId('why-before-after')).toBeVisible({ timeout: 5000 });
  // Fix recovers overload on re-run
  await expect(page.getByTestId('why-before-after')).toContainText('→ 0');
  await expect(apiNode).not.toHaveAttribute('data-health', 'overloaded');

  // 5. Inspect Config Theoretical max RPS + Latency & Mock edit changes summary latency
  await page.getByTestId('inspector-tab-config').click();
  await expect(page.getByTestId('theoretical-max-rps')).toContainText('req/s');

  const summaryTextBefore = await page.getByTestId('result-summary-card').textContent();
  await page.getByTestId('inspector-tab-latency').click();
  await page.getByLabel('Latency p50 ms').fill('90');
  await page.getByLabel('Latency p95 ms').fill('160');
  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).not.toHaveText(summaryTextBefore ?? '', {
    timeout: 5000,
  });
  const summaryTextAfter = await page.getByTestId('result-summary-card').textContent();
  expect(summaryTextAfter).not.toEqual(summaryTextBefore);

  // 6. Metrics dock charts + scrubber + theory overlay
  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('metrics-hero-chart')).toBeVisible();
  const pathsCount = await page.getByTestId('metrics-hero-chart').locator('path').count();
  expect(pathsCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('sim-scrubber')).toBeVisible();
  await expect(page.getByTestId('sim-time-readout')).toContainText('t =');

  // Switch chart mode to Latency (shows p50/p95/p99 + Erlang C)
  await page.getByRole('button', { name: 'Latency (p50/p95/p99)' }).click();
  expect(
    await page.getByTestId('metrics-hero-chart').locator('path').count(),
  ).toBeGreaterThanOrEqual(3);

  // 7. Load Template 2 ("Add a cache") -> DB remains healthy under 400 RPS
  await page.getByTestId('open-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-cache').click();
  await expect(page.getByTestId('canvas-node-cache')).toBeVisible();

  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('canvas-node-db')).toHaveAttribute('data-health', 'ok');

  // 8. Delete Load Generator -> click Run -> inline missing Load Generator prompt works
  await page.getByTestId('canvas-node-client').click();
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await expect(page.getByTestId('canvas-node-client')).not.toBeVisible();

  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('missing-client-prompt')).toBeVisible();
  await page.getByTestId('add-load-generator-btn').click();
  await expect(page.getByTestId('missing-client-prompt')).not.toBeVisible();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });

  expect(failedIconRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
