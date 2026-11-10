'use client';

import { create } from 'zustand';
import {
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import { fetchPriceSnapshotApi } from '../lib/api';

const SNAPSHOT_STORAGE_KEY = 'infrasim.priceSnapshot.v1';
const ASSUMPTIONS_STORAGE_KEY = 'infrasim.costAssumptions.v1';

interface PersistedSnapshotEnvelope {
  snapshot: PriceSnapshot;
  etag: string | null;
  fetchedAt: string | null;
  queryKey: string | null;
}

export interface CostStoreState {
  snapshot: PriceSnapshot | null;
  etag: string | null;
  lastQueryKey: string | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: string | null;
  isOfflineFallback: boolean;
  hydrated: boolean;

  hoursPerMonth: number;
  traffic: CostAssumptions['traffic'];
  instanceCountMode: CostAssumptions['instanceCountMode'];

  hydrateFromStorage: () => void;
  syncSnapshot: (
    providers: readonly string[],
    regions: readonly string[],
    options?: { force?: boolean },
  ) => Promise<void>;
  setHoursPerMonth: (hours: number) => void;
  setTrafficAssumption: (traffic: CostAssumptions['traffic']) => void;
  setInstanceCountMode: (mode: CostAssumptions['instanceCountMode']) => void;
}

function readPersistedAssumptions(): Pick<
  CostStoreState,
  'hoursPerMonth' | 'traffic' | 'instanceCountMode'
> {
  if (typeof window === 'undefined') {
    return {
      hoursPerMonth: DEFAULT_COST_ASSUMPTIONS.hoursPerMonth,
      traffic: DEFAULT_COST_ASSUMPTIONS.traffic,
      instanceCountMode: DEFAULT_COST_ASSUMPTIONS.instanceCountMode,
    };
  }
  try {
    const raw = window.localStorage.getItem(ASSUMPTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{
        hoursPerMonth: number;
        traffic: CostAssumptions['traffic'];
        instanceCountMode: CostAssumptions['instanceCountMode'];
      }>;
      const hours =
        typeof parsed.hoursPerMonth === 'number' && parsed.hoursPerMonth > 0
          ? parsed.hoursPerMonth
          : DEFAULT_COST_ASSUMPTIONS.hoursPerMonth;
      const traffic: CostAssumptions['traffic'] =
        parsed.traffic && typeof parsed.traffic.mode === 'string'
          ? parsed.traffic
          : DEFAULT_COST_ASSUMPTIONS.traffic;
      const instanceCountMode: CostAssumptions['instanceCountMode'] =
        parsed.instanceCountMode === 'peak' ? 'peak' : 'average';
      return { hoursPerMonth: hours, traffic, instanceCountMode };
    }
  } catch {
    // Ignore malformed localStorage entries
  }
  return {
    hoursPerMonth: DEFAULT_COST_ASSUMPTIONS.hoursPerMonth,
    traffic: DEFAULT_COST_ASSUMPTIONS.traffic,
    instanceCountMode: DEFAULT_COST_ASSUMPTIONS.instanceCountMode,
  };
}

function persistAssumptions(next: {
  hoursPerMonth: number;
  traffic: CostAssumptions['traffic'];
  instanceCountMode: CostAssumptions['instanceCountMode'];
}): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ASSUMPTIONS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota errors
  }
}

function persistSnapshot(env: PersistedSnapshotEnvelope): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(env));
  } catch {
    // Ignore quota errors
  }
}

let activeSyncNonce = 0;

export const useCostStore = create<CostStoreState>()((set, get) => ({
  snapshot: null,
  etag: null,
  lastQueryKey: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isOfflineFallback: false,
  hydrated: false,

  hoursPerMonth: DEFAULT_COST_ASSUMPTIONS.hoursPerMonth,
  traffic: DEFAULT_COST_ASSUMPTIONS.traffic,
  instanceCountMode: DEFAULT_COST_ASSUMPTIONS.instanceCountMode,

  hydrateFromStorage: () => {
    if (typeof window === 'undefined' || get().hydrated) return;
    const assumptions = readPersistedAssumptions();
    let loadedEnv: PersistedSnapshotEnvelope | null = null;
    try {
      const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSnapshotEnvelope>;
        if (parsed.snapshot && Array.isArray(parsed.snapshot.prices)) {
          loadedEnv = {
            snapshot: parsed.snapshot,
            etag: parsed.etag ?? null,
            fetchedAt: parsed.fetchedAt ?? parsed.snapshot.generatedAt ?? null,
            queryKey: parsed.queryKey ?? null,
          };
        }
      }
    } catch {
      // Ignore malformed cached snapshots
    }

    set({
      hydrated: true,
      hoursPerMonth: assumptions.hoursPerMonth,
      traffic: assumptions.traffic,
      instanceCountMode: assumptions.instanceCountMode,
      ...(loadedEnv
        ? {
            snapshot: loadedEnv.snapshot,
            etag: loadedEnv.etag,
            lastFetchedAt: loadedEnv.fetchedAt,
            lastQueryKey: loadedEnv.queryKey,
          }
        : {}),
    });
  },

  syncSnapshot: async (providers, regions, options) => {
    const cleanProviders = [...new Set(providers.map((p) => p.toLowerCase()))].sort();
    const cleanRegions = [...new Set(regions.map((r) => r.trim()).filter(Boolean))].sort();
    const queryKey = `${cleanProviders.join(',')}|${cleanRegions.join(',')}`;

    const state = get();
    const force = Boolean(options?.force);
    if (!force && state.lastQueryKey === queryKey && (state.snapshot || state.lastFetchedAt)) {
      return;
    }

    const nonce = ++activeSyncNonce;
    set({ loading: true, error: null });

    try {
      const res = await fetchPriceSnapshotApi(
        cleanProviders,
        cleanRegions,
        state.lastQueryKey === queryKey ? state.etag : null,
      );
      if (nonce !== activeSyncNonce) {
        return;
      }

      const nowIso = new Date().toISOString();
      if (res.notModified) {
        set((curr) => ({
          loading: false,
          error: null,
          isOfflineFallback: false,
          lastQueryKey: queryKey,
          lastFetchedAt: curr.lastFetchedAt ?? nowIso,
          etag: res.etag ?? curr.etag,
        }));
        return;
      }

      const fetchedAt = res.snapshot.generatedAt ?? nowIso;
      persistSnapshot({
        snapshot: res.snapshot,
        etag: res.etag,
        fetchedAt,
        queryKey,
      });
      set({
        snapshot: res.snapshot,
        etag: res.etag,
        lastQueryKey: queryKey,
        loading: false,
        error: null,
        lastFetchedAt: fetchedAt,
        isOfflineFallback: false,
      });
    } catch (err) {
      if (nonce !== activeSyncNonce) {
        return;
      }
      const message = err instanceof Error ? err.message : 'Unable to fetch price snapshot';
      set((curr) => ({
        loading: false,
        lastQueryKey: queryKey,
        error: message,
        isOfflineFallback: Boolean(curr.snapshot),
      }));
    }
  },

  setHoursPerMonth: (hours) => {
    const clean = Number.isFinite(hours) && hours > 0 ? Math.min(744, Math.max(1, hours)) : 730;
    const { traffic, instanceCountMode } = get();
    persistAssumptions({ hoursPerMonth: clean, traffic, instanceCountMode });
    set({ hoursPerMonth: clean });
  },

  setTrafficAssumption: (traffic) => {
    const { hoursPerMonth, instanceCountMode } = get();
    persistAssumptions({ hoursPerMonth, traffic, instanceCountMode });
    set({ traffic });
  },

  setInstanceCountMode: (instanceCountMode) => {
    const { hoursPerMonth, traffic } = get();
    persistAssumptions({ hoursPerMonth, traffic, instanceCountMode });
    set({ instanceCountMode });
  },
}));
