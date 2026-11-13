import { expect, test } from '@playwright/test';

test.describe('Onboarding tour & template gallery (T7.3 / Spec 16 §8, §9)', () => {
  test('5-step onboarding tour runs on first boot, steps through all 5 steps, finishes, and can be replayed', async ({
    page,
  }) => {
    // Clear localStorage to simulate first visit
    await page.addInitScript(() => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.removeItem(
        'infrasim.tourCompleted',
      );
    });

    await page.goto('/');

    const tourModal = page.getByTestId('onboarding-tour-modal');
    await expect(tourModal).toBeVisible();
    await expect(tourModal).toContainText('Step 1 of 5');
    await expect(tourModal).toContainText('Add cloud services');

    // Step 1 -> Step 2
    await page.getByTestId('tour-next-btn').click();
    await expect(tourModal).toContainText('Step 2 of 5');
    await expect(tourModal).toContainText('Wire traffic edges');

    // Step 2 -> Step 3
    await page.getByTestId('tour-next-btn').click();
    await expect(tourModal).toContainText('Step 3 of 5');
    await expect(tourModal).toContainText('Tune latency & mock logic');

    // Step 3 -> Step 4
    await page.getByTestId('tour-next-btn').click();
    await expect(tourModal).toContainText('Step 4 of 5');
    await expect(tourModal).toContainText('Run discrete-event simulation');

    // Step 4 -> Step 5
    await page.getByTestId('tour-next-btn').click();
    await expect(tourModal).toContainText('Step 5 of 5');
    await expect(tourModal).toContainText('Diagnose bottlenecks with Why?');

    // Finish tour
    await page.getByTestId('tour-finish-btn').click();
    await expect(tourModal).not.toBeVisible();

    // Verify localStorage persistence
    const isCompleted = await page.evaluate(() =>
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
        'infrasim.tourCompleted',
      ),
    );
    expect(isCompleted).toBe('true');

    // Replay tour via Top Bar Help button
    const helpBtn = page.getByTestId('help-tour-btn');
    await expect(helpBtn).toBeVisible();
    await helpBtn.click();
    await expect(tourModal).toBeVisible();
    await expect(tourModal).toContainText('Step 1 of 5');

    // Skip tour
    await page.getByTestId('tour-skip-btn').click();
    await expect(tourModal).not.toBeVisible();
  });

  test('Template modal lists all 10 starter templates and loads tpl-serverless-api cleanly', async ({
    page,
  }) => {
    // Mark tour already completed to focus on canvas and templates
    await page.addInitScript(() => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        'infrasim.tourCompleted',
        'true',
      );
    });

    await page.goto('/');

    // Empty canvas shows browse starter templates button and start from scratch
    const browseBtn = page.getByTestId('empty-browse-templates-button');
    await expect(browseBtn).toBeVisible();
    await expect(page.getByTestId('empty-start-scratch-btn')).toBeVisible();

    await browseBtn.click();

    const templateModal = page.getByTestId('template-modal');
    await expect(templateModal).toBeVisible();

    // Filter by 'starter'
    await page.getByTestId('template-filter-starter').click();
    await expect(templateModal).toContainText('Starter (10)');

    // Verify presence of new starter templates
    await expect(templateModal).toContainText('Serverless API');
    await expect(templateModal).toContainText('Event-driven order pipeline');
    await expect(templateModal).toContainText('Multi-AZ HA with AZ outage');
    await expect(templateModal).toContainText('Retry storm & circuit breaker');
    await expect(templateModal).toContainText('Multi-region latency & cost');
    await expect(templateModal).toContainText('Cross-cloud cost comparison');

    // Load tpl-serverless-api
    await page.getByTestId('load-template-tpl-serverless-api').click();
    await expect(templateModal).not.toBeVisible();

    // Nodes placed on canvas
    await expect(page.getByTestId('canvas-node-client')).toBeVisible();
    await expect(page.getByTestId('canvas-node-gateway')).toBeVisible();
    await expect(page.getByTestId('canvas-node-fn')).toBeVisible();
    await expect(page.getByTestId('canvas-node-db')).toBeVisible();
  });
});
