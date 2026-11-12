import path from 'node:path';
import { expect, test } from '@playwright/test';

const AWS_FIXTURE = path.resolve(
  __dirname,
  '../packages/terraform/src/__fixtures__/aws-plan.synthetic.json',
);

test('Phase 5 E2E: live Terraform HCL dock + diff, ZIP export modal, Terraform plan JSON worker import, inferred edge confirm, imported attrs, auto-layout & simulation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');

  // 1. Load 3-tier starter template and inspect live Terraform dock + live diff gutter
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-3tier').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  await page.getByTestId('dock-tab-terraform').click();
  const tfDock = page.getByTestId('terraform-dock-tab');
  await expect(tfDock).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('terraform-file-tab-compute.tf').click();
  await expect(page.getByTestId('terraform-dock-code-view')).toContainText('aws_instance');

  // Edit API node label -> verify HCL live updates with changed-line gutter marks
  await page.getByTestId('canvas-node-api').click({ force: true });
  await page.getByTestId('inspector-tab-config').click();
  await page.getByLabel('Node label').fill('Checkout API');
  await expect(page.getByTestId('terraform-dock-code-view')).toContainText('checkout_api', {
    timeout: 5_000,
  });
  await expect(
    page.getByTestId('terraform-dock-code-view').locator('tr[data-changed="true"]').first(),
  ).toBeVisible();

  // 2. Open Export Modal -> verify files, download ZIP archive cleanly
  await page.getByTestId('topbar-export-terraform-btn').click();
  await expect(page.getByTestId('terraform-export-modal')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tf-modal-code-view')).toContainText('terraform');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('tf-modal-download-zip-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-terraform\.zip$/);
  await page.getByRole('button', { name: 'Close export modal' }).click();
  await expect(page.getByTestId('terraform-export-modal')).not.toBeVisible();

  // 3. Open Import Modal -> upload synthetic AWS plan JSON -> inspect Import Report -> place on canvas
  await page.getByTestId('topbar-import-terraform-btn').click();
  await expect(page.getByTestId('terraform-import-modal')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('tf-import-file-input').setInputFiles(AWS_FIXTURE);

  const importReport = page.getByTestId('tf-import-report');
  await expect(importReport).toBeVisible({ timeout: 20_000 });
  await expect(importReport).toContainText('aws_redshift_cluster');
  await expect(importReport).toContainText('Secrets stripped');
  await expect(importReport).toContainText('Inferred connections');

  await page.getByTestId('tf-import-place-btn').click();
  await expect(page.getByTestId('terraform-import-modal')).not.toBeVisible();

  // 4. Verify unsupported Redshift node displays TF badge on canvas, and inspect Imported Terraform attributes
  const unmappedBadge = page.getByTestId('node-tf-unmapped-badge').first();
  await expect(unmappedBadge).toBeVisible({ timeout: 10_000 });

  const redshiftNode = page
    .locator('[data-testid^="canvas-node-"]', { hasText: 'Redshift' })
    .first();
  await redshiftNode.click({ force: true });
  await page.getByTestId('inspector-tab-config').click();
  const attrsPanel = page.getByTestId('imported-attrs-panel');
  await expect(attrsPanel).toBeVisible();
  await attrsPanel.locator('summary').click();
  await expect(attrsPanel).toContainText('synthetic-dwh');

  // 5. Click an inferred edge pill -> confirm inferred edge -> badge clears
  const firstInferredBadge = page.locator('[data-testid^="edge-inferred-badge-"]').first();
  await expect(firstInferredBadge).toBeVisible();
  const inferredBadgeTestId = await firstInferredBadge.getAttribute('data-testid');
  expect(inferredBadgeTestId).toBeTruthy();
  const inferredEdgeId = inferredBadgeTestId!.replace('edge-inferred-badge-', '');

  await page.getByTestId(`edge-label-${inferredEdgeId}`).click({ force: true });
  await expect(page.getByTestId('edge-inferred-banner')).toBeVisible();
  await page.getByTestId('edge-confirm-inferred-btn').click();
  await expect(page.getByTestId(`edge-inferred-badge-${inferredEdgeId}`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close edge settings' }).click();

  await page.getByTestId('canvas-auto-layout-btn').click();

  // 6. Run simulation directly on the imported Terraform architecture
  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  const summaryCard = page.getByTestId('result-summary-card');
  await expect(summaryCard).toBeVisible({ timeout: 20_000 });
  await expect(summaryCard).not.toContainText('Requests\n0');

  expect(pageErrors).toEqual([]);
});
