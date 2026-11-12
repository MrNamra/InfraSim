import { expect, type Locator, type Page, test } from '@playwright/test';

async function setMonacoSource(page: Page, source: string): Promise<void> {
  await expect(page.getByTestId('code-editor-container').locator('.monaco-editor')).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => {
        return page.evaluate((nextSrc) => {
          const w = globalThis as unknown as {
            monaco?: {
              editor: {
                getModels(): Array<{
                  getValue(): string;
                  setValue(v: string): void;
                }>;
              };
            };
          };
          const model = w.monaco?.editor?.getModels?.()[0];
          if (!model) return false;
          if (model.getValue() !== nextSrc) {
            model.setValue(nextSrc);
          }
          return model.getValue() === nextSrc;
        }, source);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function connectNodeHandles(page: Page, fromNode: Locator, toNode: Locator): Promise<void> {
  // Dismiss any open EdgePopover before fitting and connecting handles
  const edgeDone = page.getByRole('button', { name: 'Done', exact: true });
  if (await edgeDone.isVisible()) {
    await edgeDone.click();
  }

  // Fit view so newly added nodes are clearly in the canvas viewport before connecting handles
  const fitBtn = page.locator('.react-flow__controls-fitview').first();
  if (await fitBtn.isVisible()) {
    await fitBtn.click();
  }
  const sourceHandle = fromNode.locator('.react-flow__handle.source').first();
  const targetHandle = toNode.locator('.react-flow__handle.target').first();
  await expect(sourceHandle).toBeVisible();
  await expect(targetHandle).toBeVisible();

  const srcBox = await sourceHandle.boundingBox();
  const dstBox = await targetHandle.boundingBox();
  expect(srcBox && dstBox).toBeTruthy();

  await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dstBox!.x + dstBox!.width / 2, dstBox!.y + dstBox!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();

  if (await edgeDone.isVisible()) {
    await edgeDone.click();
  }
}

test('Phase 3 E2E: unmodified AWS SDK v3, one-click Auto-fill TypeError fix, Payload Doctor, k6 scenario sync, profiling, 50k virtualized logs >= 50fps, and RAG chatbot template', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const failedIconRequests: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.url().includes('/icons/services/') && res.status() >= 400) {
      failedIconRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  await page.goto('/');

  // 1. Load Simple 3-tier template and wire AWS S3 + DynamoDB downstream of API Server
  await page.getByTestId('empty-browse-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-3tier').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  const paletteSearch = page.getByPlaceholder('Search services');
  await paletteSearch.fill('DynamoDB');
  const ddbPalette = page.getByTestId('palette-item-aws.dynamodb').first();
  await expect(ddbPalette).toBeVisible();
  await ddbPalette.dblclick();

  await paletteSearch.fill('S3');
  const s3Palette = page.getByTestId('palette-item-aws.s3').first();
  await expect(s3Palette).toBeVisible();
  await s3Palette.dblclick();
  await paletteSearch.fill('');

  const apiNode = page.getByTestId('canvas-node-api');
  const ddbNode = page.locator('[data-service-id="aws.dynamodb"]').first();
  const s3Node = page.locator('[data-service-id="aws.s3"]').first();
  await expect(ddbNode).toBeVisible();
  await expect(s3Node).toBeVisible();

  await connectNodeHandles(page, apiNode, ddbNode);
  await connectNodeHandles(page, apiNode, s3Node);

  const fitBtn = page.locator('.react-flow__controls-fitview').first();
  if (await fitBtn.isVisible()) {
    await fitBtn.click();
  }

  // 2. Open Code tab on API Server and attach unmodified AWS SDK v3 handler with deliberate TypeError
  await apiNode.click({ force: true });
  await expect(page.getByTestId('inspector-tab-code')).toBeVisible();
  await page.getByTestId('inspector-tab-code').click();
  await expect(page.getByTestId('code-tab-empty')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('new-script-btn').click();
  await expect(page.getByTestId('code-tab-panel')).toBeVisible();

  const sdkAndTypeErrorHandler = `import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({ region: 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

export async function handler(event: any) {
  console.log('checking s3 and dynamodb', { path: event?.path ?? '/' });
  const obj = await s3.send(new GetObjectCommand({ Bucket: 'assets', Key: 'config.json' }));
  const s3Status = obj.$metadata?.httpStatusCode ?? 0;
  const res = await ddb.send(new GetCommand({ TableName: 'users', Key: { id: 'u1' } }));
  return {
    statusCode: 200,
    body: JSON.stringify({ userId: (res as any).Item.userId.toUpperCase(), s3Status }),
  };
}`;

  await setMonacoSource(page, sdkAndTypeErrorHandler);

  // Dry run should fail on empty DynamoDB mock (`res.Item.userId` TypeError) while S3 GetObject succeeds
  await page.getByTestId('dry-run-btn').click();
  await expect(page.getByTestId('dry-run-status-banner')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('dry-run-status-banner')).toContainText(
    /UserCodeError|TypeError|Error/i,
  );
  await expect(page.getByTestId('dry-run-calls-list')).toContainText('aws.s3.GetObject');
  await expect(page.getByTestId('dry-run-calls-list')).toContainText('aws.dynamodb.GetItem');

  // Auto-fill mocks discovers Item.userId and "Apply & re-run" fixes it in one click
  await page.getByTestId('auto-fill-mocks-btn').click();
  await expect(page.getByTestId('autofill-preview')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('autofill-preview')).toContainText('Item.userId');
  await page.getByTestId('autofill-apply-rerun-btn').click();

  await expect(page.getByTestId('dry-run-status-banner')).toContainText('Succeeded', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('dry-run-result-json')).toContainText('userId');
  await expect(page.getByTestId('dry-run-result-json')).toContainText('s3Status');
  await expect(page.getByTestId('dry-run-logs-list')).toContainText('checking s3 and dynamodb');

  // 3. Payload Doctor apigw-body-string hint + one-click fix
  await page.getByTestId('fixture-selector').selectOption('template:aws.apigw.proxy.v1');
  await page
    .getByTestId('fixture-event-editor')
    .fill(JSON.stringify({ httpMethod: 'POST', path: '/users', body: '{"userId":"u-99"}' }));

  await setMonacoSource(
    page,
    `export async function handler(event: any) {
  return {
    statusCode: 200,
    body: JSON.stringify({ id: event.body.userId }),
  };
}`,
  );
  await page.getByTestId('dry-run-btn').click();
  await expect(page.getByTestId('doctor-hint-apigw-body-string')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('doctor-fix-apigw-body-string').click();
  await expect(page.getByTestId('doctor-hint-apigw-body-string')).not.toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('dry-run-result-json')).toContainText('u-99');

  // 4. Client k6-style traffic script extraction & sync to scenario
  await page.getByTestId('canvas-node-client').click({ force: true });
  await page.getByTestId('inspector-tab-code').click();
  await page.getByTestId('new-script-btn').click();
  await setMonacoSource(
    page,
    `export const options = {
  scenarios: { browse: { rps: 180, durationS: 30 } },
  thresholds: { http_req_failed: ['rate<0.5'] },
};
export default function () {
  http.get('/orders');
  sleep(0.5);
}`,
  );
  await page.getByTestId('sync-scenario-script-btn').click();
  await expect(page.getByTestId('extracted-scenario-preview')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('extracted-scenario-preview')).toContainText('180 req/s');

  // 5. Scale API to 10x, bump k6 traffic to 900 req/s, profile 260 logs/call -> 50k virtualized logs >= 50 fps
  await setMonacoSource(
    page,
    `export const options = {
  scenarios: { browse: { rps: 900, durationS: 30 } },
  thresholds: { http_req_failed: ['rate<0.5'] },
};
export default function () {
  http.get('/orders');
}`,
  );
  await page.getByTestId('sync-scenario-script-btn').click();
  await expect(page.getByTestId('extracted-scenario-preview')).toContainText('900 req/s');

  await apiNode.click({ force: true });
  await page.getByTestId('inspector-tab-config').click();
  await page.getByRole('spinbutton', { name: 'Instances' }).fill('10');
  await page.getByTestId('inspector-tab-code').click();
  await setMonacoSource(
    page,
    `export async function handler(event: any) {
  for (let i = 0; i < 260; i++) {
    console.log('req-line-' + i);
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, path: event?.path ?? '/' }) };
}`,
  );
  await page.getByTestId('profile-iterations-select').selectOption('50');
  await page.getByTestId('profile-handler-btn').click();
  await expect(page.getByTestId('profile-cache-status')).toHaveText('Cached', {
    timeout: 25_000,
  });
  await expect(page.getByTestId('profile-cpu-calibration')).toBeVisible();

  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('dock-tab-logs').click();
  await expect(page.getByTestId('logs-dock-tab')).toBeVisible();
  await expect(page.getByTestId('logs-dock-tab')).toContainText('50,000 / 50,000', {
    timeout: 15_000,
  });

  const viewport = page.getByTestId('logs-virtual-viewport');
  await expect(viewport).toBeVisible();
  const scrollMetrics = await viewport.evaluate(async (el) => {
    const scrollHeight = el.scrollHeight;
    const spacerChildren = el.querySelectorAll('[role="button"]').length;
    el.scrollTop = 0;

    const raf = (
      globalThis as unknown as {
        requestAnimationFrame: (cb: (now: number) => void) => number;
      }
    ).requestAnimationFrame;
    const frameDeltas: number[] = [];
    let last = performance.now();
    await new Promise<void>((resolve) => {
      let step = 0;
      const tick = (now: number) => {
        frameDeltas.push(now - last);
        last = now;
        step += 1;
        el.scrollTop = Math.min(scrollHeight - el.clientHeight, step * 25_000);
        if (step < 24) {
          raf(tick);
        } else {
          resolve();
        }
      };
      raf(tick);
    });

    const settledSamples = frameDeltas.slice(2);
    const avgFrameMs =
      settledSamples.reduce((sum, d) => sum + d, 0) / Math.max(1, settledSamples.length);
    const fps = 1000 / Math.max(1, avgFrameMs);
    return { scrollHeight, spacerChildren, fps };
  });

  expect(scrollMetrics.scrollHeight).toBeGreaterThanOrEqual(50_000 * 28);
  expect(scrollMetrics.spacerChildren).toBeLessThan(80);
  expect(scrollMetrics.fps).toBeGreaterThanOrEqual(50);

  // Filter + search + inspect traced entry (`req-1`) + group by request
  const followTailBtn = page.getByRole('button', { name: 'Follow tail' });
  if (await followTailBtn.isVisible()) {
    await followTailBtn.click();
  }
  await page.getByTestId('logs-filter-source').selectOption('user');
  await page.getByTestId('logs-search-input').fill('req-line-10');
  await viewport.evaluate((el) => {
    el.scrollTop = 0;
  });
  const firstLogRow = viewport.locator('[role="button"]').first();
  await expect(firstLogRow).toContainText(/req-\d+/);
  await expect(firstLogRow).toContainText('replayed');
  await firstLogRow.click();
  await expect(page.getByTestId('log-entry-inspector')).toBeVisible();
  await expect(page.getByTestId('log-jump-to-trace')).toBeVisible();
  await expect(page.getByTestId('log-jump-to-code')).toBeVisible();

  await page.getByTestId('logs-group-toggle').click();
  await expect(viewport).toContainText(/lines/i);

  // 6. Phase 3 Starter Template: RAG chatbot -> AI config + Cost tab + Bedrock streaming dry run + Sim run
  await page.getByTestId('open-templates-button').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
  await page.getByTestId('load-template-tpl-rag-chatbot').click();
  await expect(page.getByTestId('template-modal')).not.toBeVisible();

  await expect(page.getByTestId('canvas-node-llm')).toBeVisible();
  await page.getByTestId('canvas-node-llm').click({ force: true });
  await page.getByTestId('inspector-tab-config').click();
  await expect(page.getByTestId('ai-config-section')).toBeVisible();
  await page.getByTestId('inspector-tab-cost').click();
  await expect(page.getByTestId('inspector-cost-tab')).toContainText(/input.*1M|token/i);

  await page.getByTestId('canvas-node-api').click({ force: true });
  await page.getByTestId('inspector-tab-code').click();
  await page.getByTestId('dry-run-btn').click();
  await expect(page.getByTestId('dry-run-status-banner')).toContainText('Succeeded', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('dry-run-result-json')).toContainText('reply');
  await expect(page.getByTestId('dry-run-calls-list')).toContainText('aws.bedrock.InvokeStream');

  await page.getByTestId('run-sim-button').click();
  await page.getByTestId('dock-tab-metrics').click();
  await expect(page.getByTestId('result-summary-card')).toBeVisible({ timeout: 15_000 });

  expect(failedIconRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
