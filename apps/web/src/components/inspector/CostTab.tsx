'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, Info, RotateCcw } from 'lucide-react';
import type {
  CostAssumptions,
  CostReport,
  NodeConfig,
  NodeInstance,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { formatMoney, formatUnitPrice } from '../../lib/costFormat';

const BYTES_PER_GB = 1024 ** 3;

export interface CostTabProps {
  node: NodeInstance;
  service?: ServiceDefinition;
  costReport: CostReport;
  assumptions: CostAssumptions;
  onUpdateConfig: (updater: (config: NodeConfig) => void) => void;
  onOpenCostDock: () => void;
}

const SOURCE_BADGE_LABELS: Record<'synced' | 'manual' | 'unavailable', string> = {
  synced: 'Synced',
  manual: 'Manual',
  unavailable: 'Price unavailable',
};

/** Inspector Cost tab displaying node billable lines, storage/scan inputs, SKU override, and manual unit rates. */
export function CostTab({
  node,
  service,
  costReport,
  assumptions,
  onUpdateConfig,
  onOpenCostDock,
}: CostTabProps) {
  const nodeCost = costReport.perNode[node.id] ?? { lines: [], subtotal: 0 };
  const lines = nodeCost.lines;
  const subtotal = nodeCost.subtotal;
  const currency = costReport.currency || assumptions.currency;
  const fxRate =
    currency !== 'USD' && assumptions.fxRateToUSD && assumptions.fxRateToUSD > 0
      ? assumptions.fxRateToUSD
      : null;

  const hasUnavailable = lines.some((l) => l.source === 'unavailable');
  const kind = service?.kind ?? 'compute';
  const priceModel = service?.pricing.model ?? 'unit';

  const isStorageRelevant =
    ['object', 'block', 'file', 'sql', 'kv', 'doc', 'olap', 'search', 'ts'].includes(kind) ||
    priceModel === 'gb-mo' ||
    priceModel === 'mix';
  const isQueryTbRelevant = priceModel === 'query-tb' || kind === 'olap';

  const isTokenPriced = kind === 'llm' || priceModel === 'tok';

  const [skuDraft, setSkuDraft] = useState(node.config.pricing?.skuKey ?? '');
  const [priceDraft, setPriceDraft] = useState(
    node.config.pricing?.manualUnitPrice !== undefined
      ? String(node.config.pricing.manualUnitPrice)
      : '',
  );
  const [unitDraft, setUnitDraft] = useState(node.config.pricing?.manualUnit ?? 'Hrs');
  const [inTokPriceDraft, setInTokPriceDraft] = useState(
    node.config.pricing?.manualInputPricePer1M !== undefined
      ? String(node.config.pricing.manualInputPricePer1M)
      : '',
  );
  const [outTokPriceDraft, setOutTokPriceDraft] = useState(
    node.config.pricing?.manualOutputPricePer1M !== undefined
      ? String(node.config.pricing.manualOutputPricePer1M)
      : '',
  );
  const [storageDraft, setStorageDraft] = useState(
    node.config.storageGb !== undefined ? String(node.config.storageGb) : '',
  );
  const [scannedGbDraft, setScannedGbDraft] = useState(
    node.config.scannedBytes !== undefined
      ? String(Number((node.config.scannedBytes / BYTES_PER_GB).toFixed(2)))
      : '',
  );

  useEffect(() => {
    setSkuDraft(node.config.pricing?.skuKey ?? '');
    setPriceDraft(
      node.config.pricing?.manualUnitPrice !== undefined
        ? String(node.config.pricing.manualUnitPrice)
        : '',
    );
    setUnitDraft(node.config.pricing?.manualUnit ?? 'Hrs');
    setInTokPriceDraft(
      node.config.pricing?.manualInputPricePer1M !== undefined
        ? String(node.config.pricing.manualInputPricePer1M)
        : '',
    );
    setOutTokPriceDraft(
      node.config.pricing?.manualOutputPricePer1M !== undefined
        ? String(node.config.pricing.manualOutputPricePer1M)
        : '',
    );
    setStorageDraft(node.config.storageGb !== undefined ? String(node.config.storageGb) : '');
    setScannedGbDraft(
      node.config.scannedBytes !== undefined
        ? String(Number((node.config.scannedBytes / BYTES_PER_GB).toFixed(2)))
        : '',
    );
  }, [
    node.id,
    node.config.pricing?.skuKey,
    node.config.pricing?.manualUnitPrice,
    node.config.pricing?.manualUnit,
    node.config.storageGb,
    node.config.scannedBytes,
  ]);

  const applyManualPricing = (
    nextSku: string,
    nextPriceRaw: string,
    nextUnit: string,
    nextInTokRaw = inTokPriceDraft,
    nextOutTokRaw = outTokPriceDraft,
  ) => {
    const cleanSku = nextSku.trim();
    const parsedPrice = nextPriceRaw.trim() === '' ? undefined : Number(nextPriceRaw);
    const validPrice =
      parsedPrice !== undefined && Number.isFinite(parsedPrice) && parsedPrice >= 0
        ? parsedPrice
        : undefined;
    const parsedInTok = nextInTokRaw.trim() === '' ? undefined : Number(nextInTokRaw);
    const validInTok =
      parsedInTok !== undefined && Number.isFinite(parsedInTok) && parsedInTok >= 0
        ? parsedInTok
        : undefined;
    const parsedOutTok = nextOutTokRaw.trim() === '' ? undefined : Number(nextOutTokRaw);
    const validOutTok =
      parsedOutTok !== undefined && Number.isFinite(parsedOutTok) && parsedOutTok >= 0
        ? parsedOutTok
        : undefined;
    const cleanUnit = nextUnit.trim();

    onUpdateConfig((cfg) => {
      if (
        !cleanSku &&
        validPrice === undefined &&
        validInTok === undefined &&
        validOutTok === undefined &&
        (!cleanUnit || cleanUnit === 'Hrs')
      ) {
        delete cfg.pricing;
        return;
      }
      cfg.pricing = {
        ...(cleanSku ? { skuKey: cleanSku } : {}),
        ...(validPrice !== undefined ? { manualUnitPrice: validPrice } : {}),
        ...(validPrice !== undefined && cleanUnit ? { manualUnit: cleanUnit } : {}),
        ...(validInTok !== undefined ? { manualInputPricePer1M: validInTok } : {}),
        ...(validOutTok !== undefined ? { manualOutputPricePer1M: validOutTok } : {}),
      };
    });
  };

  const handleResetPricing = () => {
    setSkuDraft('');
    setPriceDraft('');
    setUnitDraft('Hrs');
    setInTokPriceDraft('');
    setOutTokPriceDraft('');
    onUpdateConfig((cfg) => {
      delete cfg.pricing;
    });
  };

  const hasOverrides = Boolean(
    node.config.pricing?.skuKey ||
    node.config.pricing?.manualUnitPrice !== undefined ||
    node.config.pricing?.manualInputPricePer1M !== undefined ||
    node.config.pricing?.manualOutputPricePer1M !== undefined,
  );

  return (
    <div className="space-y-4 p-4 text-[12px]" data-testid="inspector-cost-tab">
      {/* On-demand rule notice */}
      <div className="flex items-start gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[11px] text-[var(--text-secondary)]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
        <div>On-demand list prices only — no reserved, savings plans, spot, or taxes</div>
      </div>

      {/* Node monthly subtotal */}
      <div
        data-testid="inspector-cost-subtotal"
        className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">Estimated monthly total</span>
          <span
            className="font-mono text-[16px] font-medium tabular-nums text-[var(--text-primary)]"
            title={
              fxRate
                ? `Original USD estimate: ${formatMoney(subtotal / fxRate, 'USD')}/mo`
                : undefined
            }
          >
            {hasUnavailable && subtotal === 0
              ? 'Price unavailable'
              : `${formatMoney(subtotal, currency)}/mo`}
          </span>
        </div>

        {fxRate ? (
          <div className="mt-1 flex items-center justify-between font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
            <span>USD equivalent</span>
            <span>{formatMoney(subtotal / fxRate, 'USD')}/mo</span>
          </div>
        ) : null}

        <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border-hairline)] pt-2">
          <span className="font-mono text-[10px] text-[var(--text-muted)]">
            Model: {priceModel}
          </span>
          <button
            type="button"
            onClick={onOpenCostDock}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
          >
            <span>Open Cost breakdown</span>
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Storage & query scan sizing inputs */}
      {isStorageRelevant || isQueryTbRelevant ? (
        <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            Monthly capacity inputs
          </div>
          {isStorageRelevant ? (
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Stored data (GB-Mo)</span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="cost-storage-gb-input"
                placeholder={kind === 'sql' || kind === 'block' || kind === 'file' ? '100' : '1'}
                value={storageDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setStorageDraft(val);
                  const num = val.trim() === '' ? undefined : Number(val);
                  onUpdateConfig((cfg) => {
                    if (num !== undefined && Number.isFinite(num) && num >= 0) {
                      cfg.storageGb = num;
                    } else {
                      delete cfg.storageGb;
                    }
                  });
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ) : null}

          {isQueryTbRelevant ? (
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">
                Scanned data per run / month (GB)
              </span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="cost-scanned-gb-input"
                placeholder="0"
                value={scannedGbDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setScannedGbDraft(val);
                  const num = val.trim() === '' ? undefined : Number(val);
                  onUpdateConfig((cfg) => {
                    if (num !== undefined && Number.isFinite(num) && num >= 0) {
                      cfg.scannedBytes = num * BYTES_PER_GB;
                    } else {
                      delete cfg.scannedBytes;
                    }
                  });
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ) : null}
        </section>
      ) : null}

      {/* Cost line items */}
      <section className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            Billable dimensions ({lines.length})
          </span>
        </div>

        {lines.length === 0 ? (
          <p className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
            No billable dimensions computed yet
          </p>
        ) : (
          <div className="space-y-2">
            {lines.map((line, idx) => (
              <div
                key={`${line.dimension}-${idx}`}
                data-testid={`cost-line-${idx}`}
                className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[var(--text-primary)]">
                      {line.dimension}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                      {line.quantity.toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                      {line.unit} × {formatUnitPrice(line.unitPrice, currency)}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div
                      className={`font-mono text-[12px] font-medium tabular-nums ${
                        line.source === 'unavailable'
                          ? 'text-[var(--text-muted)]'
                          : 'text-[var(--text-primary)]'
                      }`}
                    >
                      {line.amount !== null
                        ? formatMoney(line.amount, currency)
                        : 'Price unavailable'}
                    </div>
                    <span
                      className={`mt-0.5 inline-block rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                        line.source === 'unavailable'
                          ? 'border-[var(--border-strong)] bg-[var(--bg-sunken)] text-[var(--status-warm)]'
                          : line.source === 'manual'
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-muted)]'
                      }`}
                    >
                      {SOURCE_BADGE_LABELS[line.source]}
                    </span>
                  </div>
                </div>

                {line.skuKey || line.note ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-hairline)] pt-1.5 text-[10px] text-[var(--text-muted)]">
                    {line.skuKey ? <span className="font-mono">{line.skuKey}</span> : null}
                    {line.note ? <span>{line.note}</span> : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Manual SKU and price override */}
      <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            SKU & manual unit rate
          </span>
          {hasOverrides ? (
            <button
              type="button"
              onClick={handleResetPricing}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
              <span>Reset</span>
            </button>
          ) : null}
        </div>

        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">SKU key override</span>
          <input
            type="text"
            data-testid="cost-sku-override-input"
            placeholder={node.config.instanceType ?? service?.pricing.skuKey ?? 'Optional SKU key'}
            value={skuDraft}
            onChange={(e) => {
              const next = e.target.value;
              setSkuDraft(next);
              applyManualPricing(next, priceDraft, unitDraft);
            }}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Manual rate (USD)</span>
            <input
              type="number"
              min={0}
              step="0.0001"
              data-testid="cost-manual-price-input"
              placeholder="e.g. 0.0416"
              value={priceDraft}
              onChange={(e) => {
                const next = e.target.value;
                setPriceDraft(next);
                applyManualPricing(skuDraft, next, unitDraft);
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Billing unit</span>
            <select
              aria-label="Manual billing unit"
              data-testid="cost-manual-unit-select"
              value={unitDraft}
              onChange={(e) => {
                const next = e.target.value;
                setUnitDraft(next);
                applyManualPricing(skuDraft, priceDraft, next);
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="Hrs">Hrs</option>
              <option value="1M Requests">1M Requests</option>
              <option value="10K Requests">10K Requests</option>
              <option value="GB-Mo">GB-Mo</option>
              <option value="GB">GB</option>
              <option value="GB-Seconds">GB-Seconds</option>
              <option value="OCPU-Hours">OCPU-Hours</option>
              <option value="Month">Month</option>
            </select>
          </label>
        </div>

        {isTokenPriced ? (
          <div className="grid grid-cols-2 gap-2" data-testid="cost-manual-token-pricing">
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Input $/1M tokens</span>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 3.00"
                value={inTokPriceDraft}
                onChange={(e) => {
                  const next = e.target.value;
                  setInTokPriceDraft(next);
                  applyManualPricing(skuDraft, priceDraft, unitDraft, next, outTokPriceDraft);
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Output $/1M tokens</span>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 15.00"
                value={outTokPriceDraft}
                onChange={(e) => {
                  const next = e.target.value;
                  setOutTokPriceDraft(next);
                  applyManualPricing(skuDraft, priceDraft, unitDraft, inTokPriceDraft, next);
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          </div>
        ) : null}

        {hasUnavailable && !node.config.pricing?.manualUnitPrice ? (
          <div className="flex items-start gap-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[11px] text-[var(--text-secondary)]">
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-warm)]"
              strokeWidth={1.5}
            />
            <span>
              Public price unavailable in snapshot. Enter a manual unit rate above to include this
              node in totals.
            </span>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={onOpenCostDock}
              className="h-7 px-2.5 text-[11px]"
            >
              Compare across providers
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
