import type { Provider, ServiceDefinition } from '@infrasim/shared-types';
import { getCatalog, searchServices } from '@infrasim/catalog';

export type PaletteProviderFilter = Provider | 'all';

export const FAVORITES_STORAGE_KEY = 'infrasim.palette.favorites';
export const RECENT_STORAGE_KEY = 'infrasim.palette.recent';
export const MAX_RECENT_SERVICES = 8;

export const DRAG_SERVICE_MIME = 'application/infrasim-service';

/** Formats millisecond latencies cleanly for palette and node timing chips. */
export function formatLatencyShort(ms: number): string {
  if (ms === 0) {
    return '0 ms';
  }
  if (ms < 1) {
    return `~${Number(ms.toFixed(1))} ms`;
  }
  if (ms < 1000) {
    return `~${Math.round(ms)} ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `~${Number(sec.toFixed(1))} s`;
  }
  const min = sec / 60;
  if (min < 60) {
    return `~${Math.round(min)} min`;
  }
  const hr = min / 60;
  return `~${Number(hr.toFixed(1))} hr`;
}

/** Formats a service CapacitySpec into a concise human-readable summary. */
export function formatCapacitySummary(service: ServiceDefinition): string {
  const cap = service.capacity;
  switch (cap.type) {
    case 'elastic':
      return 'Elastic capacity';
    case 'slots':
      return 'Concurrency slots from instances';
    case 'conc':
      return `${cap.limit} concurrent (${cap.onLimit})`;
    case 'rps':
      return `${cap.limit.toLocaleString('en-US')} RPS${cap.burst ? ` (burst ${cap.burst.toLocaleString('en-US')})` : ''}`;
    case 'units':
      return `${cap.read}/${cap.write} R/W units`;
    case 'conn':
      return `${cap.default} max connections default`;
    case 'tpm':
      return `${cap.rpm ?? 0} RPM / ${((cap.tpm ?? 0) / 1000).toFixed(0)}k TPM`;
    case 'passthrough':
      return 'Network pass-through';
  }
}

export interface CategoryGroup {
  category: string;
  services: ServiceDefinition[];
}

/** Filters catalog entries by provider + search query and groups them by category. */
export function groupPaletteServices(
  query: string,
  provider: PaletteProviderFilter,
  customServices: readonly ServiceDefinition[] = [],
): CategoryGroup[] {
  const matches = searchServices(query, { provider, customServices });
  const map = new Map<string, ServiceDefinition[]>();

  for (const service of matches) {
    const existing = map.get(service.category);
    if (existing) {
      existing.push(service);
    } else {
      map.set(service.category, [service]);
    }
  }

  return Array.from(map.entries()).map(([category, services]) => ({
    category,
    services,
  }));
}

/** Resolves a list of stored service IDs against the current catalog + custom services. */
export function resolveStoredServices(
  ids: readonly string[],
  customServices: readonly ServiceDefinition[] = [],
): ServiceDefinition[] {
  const byId = new Map(getCatalog(customServices).map((s) => [s.id, s]));
  const result: ServiceDefinition[] = [];
  for (const id of ids) {
    const match = byId.get(id);
    if (match) {
      result.push(match);
    }
  }
  return result;
}

/** Inserts an ID at the front of a bounded recently-used list. */
export function pushRecentServiceId(
  current: readonly string[],
  serviceId: string,
  limit = MAX_RECENT_SERVICES,
): string[] {
  return [serviceId, ...current.filter((id) => id !== serviceId)].slice(0, limit);
}

/** Toggles a service ID inside a favorites list. */
export function toggleFavoriteServiceId(current: readonly string[], serviceId: string): string[] {
  if (current.includes(serviceId)) {
    return current.filter((id) => id !== serviceId);
  }
  return [...current, serviceId];
}

/** Safely reads a string[] list from localStorage. */
export function readStoredIdList(key: string): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** Safely writes a string[] list to localStorage. */
export function writeStoredIdList(key: string, ids: readonly string[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Ignore storage quota errors in restricted environments
  }
}
