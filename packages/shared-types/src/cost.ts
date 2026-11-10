/** Assumptions driving monthly cost extrapolation. */
export interface CostAssumptions {
  hoursPerMonth: number;
  traffic: {
    mode: 'run-average' | 'custom-monthly-requests' | 'custom-avg-rps';
    value?: number;
  };
  instanceCountMode: 'average' | 'peak';
  includeFreeTier: boolean;
  currency: 'USD' | 'INR' | 'EUR' | 'GBP';
  fxRateToUSD?: number;
}

/** Single billable line item in a cost report. */
export interface CostLine {
  dimension: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
  skuKey?: string;
  source: 'synced' | 'manual' | 'unavailable';
  note?: string;
}

/** Monthly cost report across all nodes and network transfer edges. */
export interface CostReport {
  currency: string;
  asOf: string;
  monthlyTotal: number;
  perNode: Record<string, { lines: CostLine[]; subtotal: number }>;
  transfer: CostLine[];
  byCategory: Record<string, number>;
  costPerMillionRequests: number;
  warnings: string[];
  assumptions: CostAssumptions;
}
