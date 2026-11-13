import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const assetsDir = path.resolve(__dirname, '../docs/assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Mark tour completed so modal doesn't pop up immediately
  await page.addInitScript(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'infrasim.tourCompleted',
      'true',
    );
  });

  console.log('Navigating to http://127.0.0.1:3100...');
  await page.goto('http://127.0.0.1:3100', { waitUntil: 'networkidle' });

  // 1. Load 3-tier starter template
  console.log('Loading 3-tier template...');
  const emptyTemplateBtn = page.getByTestId('empty-browse-templates-button');
  if (await emptyTemplateBtn.isVisible()) {
    await emptyTemplateBtn.click();
  } else {
    await page.getByRole('button', { name: 'Templates' }).click();
  }

  // Take screenshot of Templates modal
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(assetsDir, 'templates-modal.png') });
  console.log('Saved templates-modal.png');

  // Load tpl-3tier
  await page.getByTestId('load-template-tpl-3tier').click();
  await page.waitForTimeout(1000);

  // Take screenshot of Workbench
  await page.screenshot({ path: path.join(assetsDir, 'workbench.png') });
  console.log('Saved workbench.png');

  // Run simulation
  console.log('Running simulation...');
  const playBtn = page.getByTestId('topbar-sim-btn');
  if (await playBtn.isVisible()) {
    await playBtn.click();
    // Wait 3 seconds for simulation to run and populate charts
    await page.waitForTimeout(3000);
  }

  // Take screenshot of simulation in progress / completed
  await page.screenshot({ path: path.join(assetsDir, 'simulation-run.png') });
  console.log('Saved simulation-run.png');

  // Focus an API node to show Inspector
  const apiNode = page.getByTestId('canvas-node-api');
  if (await apiNode.isVisible()) {
    await apiNode.click();
    await page.waitForTimeout(500);
    // Switch to Why? or Config tab
    const whyTab = page.getByTestId('inspector-tab-why');
    if (await whyTab.isVisible()) {
      await whyTab.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: path.join(assetsDir, 'workbench-diagnostics.png') });
    console.log('Saved workbench-diagnostics.png');
  }

  await browser.close();
  console.log('All screenshots captured successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
