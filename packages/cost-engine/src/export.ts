import type { CostReport, Design } from '@infrasim/shared-types';

function csvEscape(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatMoney(amount: number | null, currency: string): string {
  if (amount === null || !Number.isFinite(amount)) {
    return 'price unavailable';
  }
  const symbol =
    currency === 'INR' ? '₹' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${symbol}${amount.toFixed(2)}`;
}

/** Exports all cost lines and transfer rows from a CostReport as RFC-4180 CSV. */
export function exportCostCsv(report: CostReport, design: Design): string {
  const nodesById = new Map(design.nodes.map((n) => [n.id, n]));
  const rows: string[] = [
    [
      'Scope',
      'NodeId',
      'Label',
      'ServiceId',
      'Dimension',
      'Quantity',
      'Unit',
      'UnitPrice',
      'Amount',
      'Currency',
      'Source',
      'SkuKey',
      'Note',
    ].join(','),
  ];

  for (const [nodeId, entry] of Object.entries(report.perNode)) {
    const node = nodesById.get(nodeId);
    for (const line of entry.lines) {
      rows.push(
        [
          'node',
          nodeId,
          node?.label ?? nodeId,
          node?.serviceId ?? '',
          line.dimension,
          Number(line.quantity.toFixed(4)),
          line.unit,
          line.unitPrice !== null ? Number(line.unitPrice.toFixed(6)) : '',
          line.amount !== null ? Number(line.amount.toFixed(2)) : '',
          report.currency,
          line.source,
          line.skuKey ?? '',
          line.note ?? '',
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }

  for (const line of report.transfer) {
    rows.push(
      [
        'transfer',
        '',
        'Data transfer',
        '',
        line.dimension,
        Number(line.quantity.toFixed(4)),
        line.unit,
        line.unitPrice !== null ? Number(line.unitPrice.toFixed(6)) : '',
        line.amount !== null ? Number(line.amount.toFixed(2)) : '',
        report.currency,
        line.source,
        line.skuKey ?? '',
        line.note ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  return rows.join('\n');
}

/** Exports a concise human-readable Markdown cost breakdown table for a CostReport. */
export function exportCostMarkdown(report: CostReport, design: Design): string {
  const nodesById = new Map(design.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];

  lines.push(`# Monthly Cost Estimate — ${design.name}`);
  lines.push('');
  lines.push(
    `- **Estimated Total:** ${formatMoney(report.monthlyTotal, report.currency)}/mo (${report.currency})`,
  );
  lines.push(`- **As of:** ${report.asOf}`);
  lines.push(
    `- **Assumptions:** ${report.assumptions.hoursPerMonth} hrs/mo · instances=${report.assumptions.instanceCountMode} · traffic=${report.assumptions.traffic.mode} · freeTier=${report.assumptions.includeFreeTier ? 'on' : 'off'}`,
  );
  lines.push(
    `- **Per 1M requests:** ${formatMoney(report.costPerMillionRequests, report.currency)}`,
  );
  lines.push('');
  lines.push('> On-demand list prices only (no reserved, savings plans, spot, or taxes).');
  lines.push('');

  lines.push('## Per-node breakdown');
  lines.push('');
  lines.push('| Node | Dimension | Quantity | Unit Price | Monthly Amount | Source |');
  lines.push('|---|---|---:|---:|---:|---|');

  for (const [nodeId, entry] of Object.entries(report.perNode)) {
    const node = nodesById.get(nodeId);
    const label = node?.label ?? nodeId;
    for (const item of entry.lines) {
      lines.push(
        `| ${label} | ${item.dimension} | ${item.quantity.toFixed(2)} ${item.unit} | ${
          item.unitPrice !== null ? item.unitPrice.toFixed(5) : 'unavailable'
        } | ${formatMoney(item.amount, report.currency)} | ${item.source} |`,
      );
    }
  }

  if (report.transfer.length > 0) {
    lines.push('');
    lines.push('## Data transfer');
    lines.push('');
    lines.push('| Category | Quantity | Unit Price | Monthly Amount | Notes |');
    lines.push('|---|---:|---:|---:|---|');
    for (const item of report.transfer) {
      lines.push(
        `| ${item.dimension} | ${item.quantity.toFixed(2)} ${item.unit} | ${
          item.unitPrice !== null ? item.unitPrice.toFixed(5) : 'unavailable'
        } | ${formatMoney(item.amount, report.currency)} | ${item.note ?? ''} |`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const warn of report.warnings) {
      lines.push(`- ${warn}`);
    }
  }

  return lines.join('\n');
}
