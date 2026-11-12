import { expect, test } from '@playwright/test';

test('Phase 4 E2E: networking lessons gallery, blocked edge inspection, diff preview + apply fix recovery, and ETIMEDOUT vs ECONNREFUSED logs', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');

  // 1. Open templates modal, filter to Networking lessons (8), verify count, and load "My DB is unreachable"
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('template-filter-network').click();
  await expect(page.locator('[data-testid^="template-card-tpl-net-"]')).toHaveCount(8);

  await page.getByTestId('load-template-tpl-net-db-unreachable').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  // 2. Canvas shows Public/Private subnet badges and blocked red dashed edge e-api-db
  await expect(page.getByTestId('subnet-visibility-sub-pub')).toContainText('Public');
  await expect(page.getByTestId('subnet-visibility-sub-priv')).toContainText('Private');
  await expect(page.getByTestId('edge-label-e-api-db')).toHaveAttribute(
    'data-network-state',
    'blocked',
    { timeout: 10_000 },
  );

  // 3. Run initial simulation: blocked edge causes connection timeouts & high error rate
  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  const summaryCard = page.getByTestId('result-summary-card');
  await expect(summaryCard).toBeVisible({ timeout: 20_000 });
  const initialSummaryText = await summaryCard.innerText();
  const initialErrorMatch = initialSummaryText.match(/Errors\s*(\d+\.\d+%)/);
  expect(initialErrorMatch).toBeTruthy();
  const initialErrorPctStr = initialErrorMatch![1]!;
  expect(Number.parseFloat(initialErrorPctStr)).toBeGreaterThan(50);

  await page.getByTestId('dock-tab-logs').click();
  await expect(page.getByTestId('logs-dock-tab')).toContainText('ETIMEDOUT', { timeout: 10_000 });

  // 4. Open Reachability dock, check all edges, preview least-privilege JSON Patch diff, apply fix
  await page.getByTestId('dock-tab-reachability').click();
  await expect(page.getByTestId('reachability-dock-tab')).toBeVisible();
  await page.getByTestId('check-all-edges-btn').click();

  await expect(page.getByTestId('reachability-edge-row-e-api-db')).toContainText('SG_NO_INGRESS');
  await expect(page.getByTestId('reachability-edge-row-e-api-db')).toContainText('ETIMEDOUT');
  await expect(page.getByTestId('reachability-hop-trace')).toBeVisible();

  const diffPreview = page.getByTestId('network-fix-diff-preview');
  await expect(diffPreview).toBeVisible();
  await expect(diffPreview).toContainText('sg-api');
  await expect(diffPreview).not.toContainText('0.0.0.0/0');

  await page.getByTestId('apply-network-fix-btn').click();
  await expect(page.getByTestId('network-fix-applied-banner')).toBeVisible();

  // Edge immediately transitions from blocked to reachable on canvas
  await expect(page.getByTestId('edge-label-e-api-db')).toHaveAttribute(
    'data-network-state',
    'reachable',
    { timeout: 10_000 },
  );

  // 5. Re-run simulation right from Reachability banner and confirm traffic recovers to 0% errors
  await page.getByTestId('rerun-after-net-fix-btn').click();
  await page.getByTestId('dock-tab-metrics').click();
  await expect(summaryCard).toContainText('0.00%', { timeout: 20_000 });
  await expect(summaryCard).toContainText(`was ${initialErrorPctStr}`);

  // 6. Load "Timeout vs refused" lesson and verify both ETIMEDOUT and ECONNREFUSED appear in logs
  await page.getByTestId('open-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('template-filter-network').click();
  await page.getByTestId('load-template-tpl-net-timeout-vs-refused').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  await expect(page.getByTestId('edge-label-e-timeout')).toHaveAttribute(
    'data-network-state',
    'blocked',
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('edge-label-e-refused')).toHaveAttribute(
    'data-network-state',
    'blocked',
    { timeout: 10_000 },
  );

  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('dock-tab-logs').click();
  await expect(page.getByTestId('logs-dock-tab')).toContainText('ETIMEDOUT', { timeout: 15_000 });
  await expect(page.getByTestId('logs-dock-tab')).toContainText('ECONNREFUSED', {
    timeout: 15_000,
  });

  expect(pageErrors).toEqual([]);
});
