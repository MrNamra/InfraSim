/** Shared consistent currency and snapshot-age formatters across cost UI panels. */

export function currencySymbol(currency: string): string {
  switch (currency) {
    case 'INR':
      return '₹';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'USD':
    default:
      return '$';
  }
}

/** Format a monthly currency total consistently with two decimals and grouping. */
export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return 'Price unavailable';
  }
  const sym = currencySymbol(currency);
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-${sym}${formatted}` : `${sym}${formatted}`;
}

/** Format unit rates up to 5 significant decimal digits (or 2 decimals when >= $1). */
export function formatUnitPrice(unitPrice: number | null | undefined, currency = 'USD'): string {
  if (unitPrice === null || unitPrice === undefined || !Number.isFinite(unitPrice)) {
    return 'Price unavailable';
  }
  const sym = currencySymbol(currency);
  if (unitPrice === 0) return `${sym}0.00`;
  if (unitPrice >= 1) return `${sym}${unitPrice.toFixed(2)}`;
  if (unitPrice >= 0.01) return `${sym}${unitPrice.toFixed(4)}`;
  return `${sym}${unitPrice.toFixed(5)}`;
}

/** Format compact node/topbar monthly chips ($42/mo, $1.4k/mo, $0/mo). */
export function formatCompactMonthlyCost(
  amount: number | null | undefined,
  currency = 'USD',
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return `${currencySymbol(currency)}?`;
  }
  const sym = currencySymbol(currency);
  if (amount === 0) return `${sym}0/mo`;
  if (amount > 0 && amount < 0.01) return `<${sym}0.01/mo`;
  if (amount < 10) return `${sym}${amount.toFixed(2)}/mo`;
  if (amount < 1000) return `${sym}${Math.round(amount)}/mo`;
  if (amount < 1_000_000) return `${sym}${(amount / 1000).toFixed(1)}k/mo`;
  return `${sym}${(amount / 1_000_000).toFixed(1)}M/mo`;
}

/** Human-readable age label from an ISO timestamp (pure display formatting). */
export function formatSnapshotAge(isoDate: string | null | undefined): string {
  if (!isoDate) return 'No snapshot';
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) return isoDate;
  const diffMs = Math.max(0, Date.now() - parsed);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
