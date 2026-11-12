import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeDesignNetwork } from '@infrasim/network-analyzer';
import { runSimulation } from '@infrasim/sim-engine';
import { exportDesignToTerraform, validateHclSyntax } from '@infrasim/terraform';
import { describe, expect, it } from 'vitest';
import { runTerraformImportInWorker } from './terraformImportClient';
import { STARTER_TEMPLATES } from './templates';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const AWS_FIXTURE_PATH = resolve(
  THIS_DIR,
  '../../../../packages/terraform/src/__fixtures__/aws-plan.synthetic.json',
);

describe('@infrasim/terraform cross-package simulation & template HCL verification (T5.6)', () => {
  it('simulates an imported Terraform architecture cleanly through network-analyzer and sim-engine', async () => {
    const rawPlan = readFileSync(AWS_FIXTURE_PATH, 'utf8');
    const imported = await runTerraformImportInWorker(rawPlan, { designName: 'Imported Sim Run' });

    const networkAnalysis = analyzeDesignNetwork(imported.design);
    expect(Object.keys(networkAnalysis.edges)).toHaveLength(imported.design.edges.length);

    const scenarioId = imported.design.scenarios[0]!.id;
    const simResult = await runSimulation(
      { design: imported.design, scenarioId, seed: 42 },
      () => {},
    );
    const replay = await runSimulation({ design: imported.design, scenarioId, seed: 42 }, () => {});

    expect(simResult.summary.totalRequests).toBeGreaterThan(0);
    expect(simResult.series.buckets.length).toBeGreaterThan(0);
    expect(replay.summary).toEqual(simResult.summary);

    const alb = imported.design.nodes.find((n) => n.serviceId === 'aws.alb')!;
    expect(simResult.perNode[alb.id]?.requests).toBeGreaterThan(0);
  });

  it('exports syntactically valid HCL for every built-in starter and networking template', () => {
    for (const tpl of STARTER_TEMPLATES) {
      const res = exportDesignToTerraform(tpl.design);
      expect(res.files.length).toBeGreaterThan(0);
      for (const file of res.files) {
        if (file.language === 'hcl') {
          const check = validateHclSyntax(file.content, `${tpl.id}/${file.filename}`);
          expect(check.errors, `Template ${tpl.id} -> ${file.filename}`).toEqual([]);
          expect(check.valid).toBe(true);
        }
      }
    }
  });
});
