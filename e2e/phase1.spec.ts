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

  // Verify dark-mode React Flow Controls & MiniMap match Graphite surface instead of light defaults
  const readBgRgb = async (selector: string) => {
    return page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const node = el as unknown as {
          ownerDocument?: {
            defaultView?: { getComputedStyle(n: unknown): { backgroundColor: string } };
          };
        };
        const css =
          node.ownerDocument?.defaultView?.getComputedStyle(el).backgroundColor ??
          'rgb(255, 255, 255)';
        const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
      });
  };
  const ctrlBg = await readBgRgb('.react-flow__controls-button');
  const mapBg = await readBgRgb('.react-flow__minimap');
  expect(ctrlBg[0]).toBeLessThan(60);
  expect(mapBg[0]).toBeLessThan(60);

  // Verify starter template edge label fits clearly without overlapping Client or ALB nodes
  const edgeLabel = page.getByTestId('edge-label-e-client-alb');
  await expect(edgeLabel).toBeVisible();
  const [clientBox0, albBox0, labelBox0] = await Promise.all([
    page.getByTestId('canvas-node-client').boundingBox(),
    page.getByTestId('canvas-node-alb').boundingBox(),
    edgeLabel.boundingBox(),
  ]);
  expect(clientBox0 && albBox0 && labelBox0).toBeTruthy();
  expect(labelBox0!.x).toBeGreaterThanOrEqual(clientBox0!.x + clientBox0!.width - 1);
  expect(labelBox0!.x + labelBox0!.width).toBeLessThanOrEqual(albBox0!.x + 1);

  // 2. Run spike scenario -> API turns red/overloaded + shakes + single particle canvas layer runs
  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });
  await expect(apiNode).toHaveAttribute('data-health', 'overloaded');
  await expect(apiNode).toHaveClass(/infrasim-shake/);
  // Never color-only: sr-only/text status & non-color cue present
  await expect(apiNode).toContainText(/Overloaded/i);
  // Even with live RPS text ("https:443 · 160/s"), starter template label stays inline without clipping
  await expect(edgeLabel).toHaveAttribute('data-offset', 'false');
  const particlesCanvas = page.getByTestId('edge-particles-canvas');
  await expect(particlesCanvas).toBeAttached();
  await expect(async () => {
    const count = Number(await particlesCanvas.getAttribute('data-active-particles'));
    expect(count).toBeGreaterThan(0);
  }).toPass({ timeout: 2000 });

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

  // 6. Metrics dock charts + interactive drag cursor + Stop button during 1x/custom playback
  await page.getByTestId('dock-tab-metrics').click();
  const chart = page.getByTestId('metrics-hero-chart');
  await expect(chart).toBeVisible();
  const pathsCount = await chart.locator('path').count();
  expect(pathsCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('sim-scrubber')).toBeVisible();
  await expect(page.getByTestId('sim-time-readout')).toContainText('t =');
  await expect(page.getByTestId('metrics-chart-cursor')).toBeVisible();

  // Switch Scenario -> custom shape -> edit/click custom arrival curve -> run at 1x speed
  await page.getByTestId('scenario-button').click();
  await expect(page.getByTestId('traffic-profile-editor')).toBeVisible();
  await page.getByLabel('Traffic curve shape').selectOption('custom');
  await page.getByRole('button', { name: 'Add custom timeline point' }).click();
  await expect(page.getByLabel('Point 5 second')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByTestId('sim-speed-select').selectOption('1');
  await page.getByTestId('run-sim-button').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });
  // Play/Run button stays converted to Stop for active buffered playback too
  await expect(page.getByTestId('stop-sim-button')).toBeVisible();
  await expect(page.getByTestId('run-sim-button')).toHaveCount(0);
  await expect(page.getByTestId('pause-sim-button')).toHaveAttribute(
    'aria-label',
    'Pause playback',
  );

  // Drag cursor across custom timeline chart (releasing outside SVG border still tracks smoothly)
  const chartBox = await chart.boundingBox();
  expect(chartBox).toBeTruthy();
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.2, chartBox!.y + chartBox!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.75, chartBox!.y + chartBox!.height + 12, {
    steps: 8,
  });
  // Dragging cursor updates playhead to ~75% of 30s (00:22.x) AND pauses active playback cleanly
  await expect(page.getByTestId('sim-time-readout')).toContainText(/t = 00:2[123]\./);
  await page.mouse.up();
  await expect(page.getByTestId('run-sim-button')).toBeVisible();

  // Buffered Play button starts playback even from stopped state & converts primary button to Stop
  await page.getByTestId('pause-sim-button').click();
  await expect(page.getByTestId('stop-sim-button')).toBeVisible();
  await page.getByTestId('stop-sim-button').click();
  await expect(page.getByTestId('run-sim-button')).toBeVisible();
  await page.getByTestId('sim-speed-select').selectOption('max');

  // Switch chart mode to Latency (shows p50/p95/p99 + Erlang C)
  await page.getByRole('button', { name: 'Latency (p50/p95/p99)' }).click();
  expect(await chart.locator('path').count()).toBeGreaterThanOrEqual(3);

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

  // 9. Drag ALB close to Client -> tight-gap edge label lifts clear above cards instead of hiding underneath
  const albNode = page.getByTestId('canvas-node-alb');
  const albDragBox = await albNode.boundingBox();
  expect(albDragBox).toBeTruthy();
  await page.mouse.move(
    albDragBox!.x + albDragBox!.width / 2,
    albDragBox!.y + albDragBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(albDragBox!.x - 90, albDragBox!.y + albDragBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  const tightLabel = page.getByTestId('edge-label-e-alb-api').first();
  const albTightEdge = page.locator('[data-testid^="edge-label-"]').first();
  await expect(albTightEdge).toBeVisible();
  const clientEdgeBox = await albNode.boundingBox();
  // Check any lifted edge or move Read API close to ALB to force tight gap cleanly
  const apiNodeEnd = page.getByTestId('canvas-node-api');
  const apiBoxEnd = await apiNodeEnd.boundingBox();
  if (apiBoxEnd && clientEdgeBox) {
    await page.mouse.move(apiBoxEnd.x + apiBoxEnd.width / 2, apiBoxEnd.y + apiBoxEnd.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      clientEdgeBox.x + clientEdgeBox.width - 10,
      apiBoxEnd.y + apiBoxEnd.height / 2,
      {
        steps: 10,
      },
    );
    await page.mouse.up();
    await expect(tightLabel).toHaveAttribute('data-offset', 'true');
    const [tightAlbBox, tightApiBox, tightLabelBox] = await Promise.all([
      albNode.boundingBox(),
      apiNodeEnd.boundingBox(),
      tightLabel.boundingBox(),
    ]);
    expect(tightAlbBox && tightApiBox && tightLabelBox).toBeTruthy();
    // Lifted label bottom sits cleanly above or clear of the card band (never buried inside cards)
    expect(tightLabelBox!.y + tightLabelBox!.height).toBeLessThanOrEqual(
      Math.max(tightAlbBox!.y, tightApiBox!.y) + 6,
    );
  }

  expect(failedIconRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
