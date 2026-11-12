import { expect, type Page, test } from '@playwright/test';

const TEST_SNAPSHOT_PAYLOAD = {
  version: 1,
  generatedAt: '2026-11-10T12:00:00.000Z',
  staleAfterDays: 7,
  providers: {
    aws: { fetchedAt: '2026-11-10T11:30:00.000Z', stale: false },
    gcp: { fetchedAt: '2026-11-10T11:30:00.000Z', stale: false },
    azure: { fetchedAt: '2026-11-10T11:30:00.000Z', stale: false },
    oci: { fetchedAt: '2026-11-10T11:30:00.000Z', stale: false },
  },
  prices: [
    // AWS us-east-1 + ap-south-1
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.small',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0208,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 2 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.small',
      region: 'ap-south-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.024,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 2 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.alb',
      skuKey: 'alb-hour',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0225,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.alb',
      skuKey: 'alb-lcu',
      region: 'us-east-1',
      unit: 'LCU-Hours',
      unitRole: 'lcu_hour',
      unitPrice: 0.008,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.alb',
      skuKey: 'alb-hour',
      region: 'ap-south-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0243,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.rds_postgres',
      skuKey: 'db.t3.medium',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.068,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.rds_postgres',
      skuKey: 'db.t3.medium',
      region: 'ap-south-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.075,
      currency: 'USD',
    },
    // GCP us-east4
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'e2-core',
      region: 'us-east4',
      unit: 'vCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.0218,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'e2-ram',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.0029,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.lb_https',
      skuKey: 'lb-rule',
      region: 'us-east4',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.025,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.lb_https',
      skuKey: 'lb-data',
      region: 'us-east4',
      unit: 'GB',
      unitRole: 'lcu_hour',
      unitPrice: 0.008,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.cloud_sql_postgres',
      skuKey: 'sql-vcpu',
      region: 'us-east4',
      unit: 'vCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.0413,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.cloud_sql_postgres',
      skuKey: 'sql-ram',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.007,
      currency: 'USD',
    },
    // Azure eastus
    {
      provider: 'azure',
      serviceId: 'azure.vm',
      skuKey: 'Standard_B2s',
      region: 'eastus',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0416,
      currency: 'USD',
    },
    // OCI global
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'VM.Standard.E4.Flex-ocpu',
      region: 'global',
      unit: 'OCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.025,
      currency: 'USD',
    },
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'VM.Standard.E4.Flex-ram',
      region: 'global',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.0015,
      currency: 'USD',
    },
  ],
  knownUnavailable: [],
};

async function maybeCapture(page: Page, name: string): Promise<void> {
  const dir = process.env.INFRASIM_AUDIT_SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}

test('Phase 2 E2E: operation mock preview, price unavailability & manual override, synced multi-cloud cost & switch, chaos & traces waterfall', async ({
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

  // 1. Offline mode first: never invent prices when price snapshot fails / is absent
  let serveSyncedPrices = false;
  await page.route('**/api/prices/snapshot**', async (route) => {
    if (!serveSyncedPrices) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Simulated offline price service' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ETag: '"e2e-snap-v1"' },
      body: JSON.stringify(TEST_SNAPSHOT_PAYLOAD),
    });
  });

  await page.goto('/');

  // Browse templates -> load Simple 3-tier web app
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-3tier').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  // Offline / no-snapshot shows "$?" on cost pill and node cost chips (never invented)
  await expect(page.getByTestId('topbar-cost-pill')).toContainText('$?');
  const apiNode = page.getByTestId('canvas-node-api');
  await expect(apiNode.getByTestId('node-cost-chip')).toContainText('$?');

  await page.getByTestId('dock-tab-cost').click();
  await expect(page.getByTestId('cost-dock-tab')).toBeVisible();
  await expect(page.getByTestId('dock-cost-total')).toContainText('$0.00/mo');
  await expect(page.getByTestId('cost-dock-tab')).toContainText(/Price unavailable/i);

  // Select API node -> Cost tab -> verify Price unavailable + manual rate override
  await apiNode.click({ force: true });
  await page.getByTestId('inspector-tab-cost').click();
  await expect(page.getByTestId('inspector-cost-tab')).toBeVisible();
  await expect(page.getByTestId('inspector-cost-subtotal')).toContainText(/Price unavailable/i);

  await page.getByTestId('cost-manual-price-input').fill('0.05');
  await expect(page.getByTestId('inspector-cost-subtotal')).toContainText('$36.50/mo');
  await expect(apiNode.getByTestId('node-cost-chip')).toContainText('$37/mo');
  await maybeCapture(page, 'phase2-dark-inspector-cost-manual');

  // Clear manual rate so synced pricing drives API node
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByTestId('inspector-cost-subtotal')).toContainText(/Price unavailable/i);

  // 2. Config tab: "Typical default — edit me" + unknown instanceType hint
  await page.getByTestId('inspector-tab-config').click();
  await expect(page.getByTestId('inspector-config-tab')).toContainText(
    /Typical default — edit me/i,
  );
  await page.getByLabel('Instance type').fill('t3.custom-unknown');
  await expect(page.getByTestId('unknown-instance-type-hint')).toBeVisible();
  await page.getByLabel('Instance type').fill('t3.small');
  await expect(page.getByTestId('unknown-instance-type-hint')).not.toBeVisible();

  // 3. Operation-level mock editor: DB node Query template edit + Preview + p50/p95 override
  await page.getByTestId('canvas-node-db').click();
  await expect(page.getByTestId('inspector-panel')).toContainText('PostgreSQL');
  await page.getByTestId('inspector-tab-latency').click();
  await expect(page.getByTestId('inspector-latency-tab')).toContainText(
    /Typical default — edit me/i,
  );
  await page.getByTestId('op-row-Query').getByRole('button').first().click();
  await expect(page.getByTestId('op-editor-Query')).toBeVisible();
  await page
    .getByLabel('Query response template')
    .fill('{"orderId":"{{input.id}}","source":"mock-preview"}');
  await page.getByTestId('op-preview-btn-Query').click();
  await expect(page.getByTestId('op-preview-output-Query')).toContainText(
    '"source":"mock-preview"',
  );

  // Edit DB p50 / p95 on Latency & Mock tab
  await page.getByLabel('Latency p50 ms').fill('18');
  await page.getByLabel('Latency p95 ms').fill('48');

  // 4. Enable synced public price snapshot -> Refresh -> verify live synced pricing across canvas, dock & assumptions
  serveSyncedPrices = true;
  await page.getByTestId('cost-refresh-btn').click();
  await expect(page.getByTestId('dock-cost-total')).not.toContainText('$0.00/mo', {
    timeout: 5000,
  });
  await expect(page.getByTestId('topbar-cost-pill')).not.toContainText('$?');
  await expect(apiNode.getByTestId('node-cost-chip')).not.toContainText('$?');

  // Test Topbar cost assumptions popover (hours/month adjustment recalculates total immediately)
  const totalBeforeAssumptions = await page.getByTestId('dock-cost-total').textContent();
  await page.getByTestId('topbar-cost-pill').click();
  await expect(page.getByTestId('cost-assumptions-popover')).toBeVisible();
  await maybeCapture(page, 'phase2-dark-cost-assumptions-and-dock');
  await page.getByLabel('Hours / month').fill('365');
  await page.getByTestId('cost-assumptions-popover').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('dock-cost-total')).not.toHaveText(totalBeforeAssumptions ?? '');
  // Restore 730h for crisp totals
  await page.getByTestId('topbar-cost-pill').click();
  await page.getByLabel('Hours / month').fill('730');
  await page.getByTestId('cost-assumptions-popover').getByRole('button', { name: 'Done' }).click();

  // What-if estimator + CSV/Markdown export + multi-cloud & regional comparison
  await page.getByTestId('cost-whatif-toggle').click();
  await expect(page.getByTestId('cost-whatif-panel')).toBeVisible();
  await expect(page.getByTestId('cost-whatif-total')).toBeVisible();

  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cost-export-csv-btn').click(),
  ]);
  expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/);

  const [mdDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cost-export-md-btn').click(),
  ]);
  expect(mdDownload.suggestedFilename()).toMatch(/\.md$/);

  await page.getByTestId('cost-subtab-compare').click();
  await expect(page.getByTestId('cost-comparison-view')).toBeVisible();
  await expect(page.getByTestId('compare-provider-row-aws')).toBeVisible();
  await expect(page.getByTestId('compare-provider-row-gcp')).toBeVisible();
  await expect(page.getByTestId('compare-provider-row-azure')).toBeVisible();
  await expect(page.getByTestId('compare-provider-row-oci')).toBeVisible();

  await page.getByTestId('compare-mode-regions').click();
  await expect(page.getByTestId('compare-region-row-ap-south-1')).toBeVisible();
  await page.getByTestId('compare-mode-providers').click();

  // 5. Open Cross-cloud switch modal -> verify Approximate badge -> apply switch to GCP -> Undo back to AWS
  await page.getByTestId('compare-switch-btn-gcp').click();
  await expect(page.getByTestId('provider-switch-modal')).toBeVisible();
  await expect(page.getByTestId('provider-switch-approx-badge')).toContainText(
    /Approximate mapping/i,
  );
  await maybeCapture(page, 'phase2-dark-provider-switch-modal');
  await page.getByTestId('confirm-provider-switch-btn').click();
  await expect(page.getByTestId('provider-switch-modal')).not.toBeVisible();

  await expect(apiNode).toHaveAttribute('data-service-id', 'gcp.compute_engine');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(apiNode).toHaveAttribute('data-service-id', 'aws.ec2');

  // 6. Inject deterministic Chaos via right-click context menu -> ChaosTimelineEditor
  await apiNode.click({ button: 'right', force: true });
  await expect(page.getByTestId('node-context-menu')).toBeVisible();
  await page.getByTestId('context-menu-inject-chaos').click();
  await expect(page.getByTestId('scenario-popover')).toBeVisible();
  await expect(page.getByTestId('chaos-timeline-editor')).toBeVisible();
  await page.getByTestId('add-chaos-event-btn').click();
  await expect(page.getByTestId('chaos-event-form')).toBeVisible();
  await page.getByTestId('chaos-kind-select').selectOption('add-latency');
  await page.getByTestId('chaos-at-input').fill('5');
  await page.getByTestId('chaos-duration-input').fill('10');
  await page.getByTestId('chaos-param-input').fill('250');
  await maybeCapture(page, 'phase2-dark-chaos-timeline-editor');
  await page.getByTestId('scenario-popover').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('scenario-chaos-count')).toContainText('1 chaos');

  // 7. Run simulation -> check Metrics chaos band & interactive Traces waterfall
  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('metrics-chaos-band')).toBeVisible();
  await maybeCapture(page, 'phase2-dark-metrics-chaos-band');

  await page.getByTestId('dock-tab-traces').click();
  await expect(page.getByTestId('traces-dock-tab')).toBeVisible();
  await expect(page.getByTestId('trace-waterfall-panel')).toBeVisible();
  const waterfallSpans = page.locator('[data-testid^="waterfall-span-"]');
  expect(await waterfallSpans.count()).toBeGreaterThanOrEqual(2);
  await maybeCapture(page, 'phase2-dark-traces-waterfall');

  // Click a span row in waterfall -> selects corresponding node & updates inspector
  await waterfallSpans.filter({ hasText: 'API Server' }).first().click();
  await expect(apiNode).toHaveClass(/ring-1/);

  // Filter traces cleanly
  await page.getByTestId('traces-filter-errors').click();
  await page.getByTestId('traces-filter-all').click();

  // Light theme audit screenshot check
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await maybeCapture(page, 'phase2-light-traces-and-canvas');
  await page.getByTestId('dock-tab-cost').click();
  await maybeCapture(page, 'phase2-light-cost-compare');
  await page.getByTestId('theme-toggle').click();

  // Verify adding a catalog item from non-AWS provider via Palette search still works
  await page.getByTestId('palette-panel').getByRole('tab', { name: 'GCP', exact: true }).click();
  await page.getByLabel('Search catalog services').fill('Cloud Run');
  const gcpRun = page.getByTestId('palette-item-gcp.cloud_run');
  await expect(gcpRun).toBeVisible();
  await gcpRun.dblclick();
  await expect(page.locator('[data-service-id="gcp.cloud_run"]')).toBeVisible();

  expect(failedIconRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
