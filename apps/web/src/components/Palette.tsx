'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, Star, X } from 'lucide-react';
import type { ServiceDefinition } from '@infrasim/shared-types';
import {
  DRAG_SERVICE_MIME,
  FAVORITES_STORAGE_KEY,
  RECENT_STORAGE_KEY,
  formatCapacitySummary,
  formatLatencyShort,
  groupPaletteServices,
  pushRecentServiceId,
  readStoredIdList,
  resolveStoredServices,
  toggleFavoriteServiceId,
  writeStoredIdList,
  type PaletteProviderFilter,
} from '../lib/palette';
import { PROVIDER_META, ServiceIcon } from './ServiceIcon';

const PROVIDER_TABS: { id: PaletteProviderFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
  { id: 'oci', label: 'OCI' },
  { id: 'generic', label: 'Generic' },
  { id: 'custom', label: 'Custom' },
];

export interface PaletteProps {
  customServices?: readonly ServiceDefinition[];
  onAddService: (serviceId: string) => void;
  onAddGroup?: (kind: 'region' | 'vpc' | 'az' | 'subnet' | 'cluster' | 'compartment') => void;
  onRequestCustomService?: () => void;
}

/** Searchable service catalog sidebar supporting drag-to-canvas and double-click insert. */
export function Palette({
  customServices = [],
  onAddService,
  onAddGroup,
  onRequestCustomService,
}: PaletteProps) {
  const [providerTab, setProviderTab] = useState<PaletteProviderFilter>('all');
  const [search, setSearch] = useState('');
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [hoveredService, setHoveredService] = useState<ServiceDefinition | null>(null);

  useEffect(() => {
    setFavoriteIds(readStoredIdList(FAVORITES_STORAGE_KEY));
    setRecentIds(readStoredIdList(RECENT_STORAGE_KEY));
  }, []);

  const categoryGroups = useMemo(
    () => groupPaletteServices(search, providerTab, customServices),
    [search, providerTab, customServices],
  );

  const totalCount = useMemo(
    () => categoryGroups.reduce((acc, g) => acc + g.services.length, 0),
    [categoryGroups],
  );

  const favoriteServices = useMemo(() => {
    const items = resolveStoredServices(favoriteIds, customServices);
    return providerTab === 'all' ? items : items.filter((s) => s.provider === providerTab);
  }, [favoriteIds, customServices, providerTab]);

  const recentServices = useMemo(() => {
    const items = resolveStoredServices(recentIds, customServices);
    return providerTab === 'all' ? items : items.filter((s) => s.provider === providerTab);
  }, [recentIds, customServices, providerTab]);

  const handleToggleFavorite = (serviceId: string) => {
    setFavoriteIds((prev) => {
      const next = toggleFavoriteServiceId(prev, serviceId);
      writeStoredIdList(FAVORITES_STORAGE_KEY, next);
      return next;
    });
  };

  const handleInsertService = (serviceId: string) => {
    setRecentIds((prev) => {
      const next = pushRecentServiceId(prev, serviceId);
      writeStoredIdList(RECENT_STORAGE_KEY, next);
      return next;
    });
    onAddService(serviceId);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, serviceId: string) => {
    event.dataTransfer.setData(DRAG_SERVICE_MIME, serviceId);
    event.dataTransfer.setData('text/plain', serviceId);
    event.dataTransfer.effectAllowed = 'copy';
  };

  const toggleCategory = (key: string) => {
    setCollapsedCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderServiceRow = (service: ServiceDefinition, keyPrefix: string) => {
    const isFav = favoriteIds.includes(service.id);
    const meta = PROVIDER_META[service.provider];

    return (
      <div
        key={`${keyPrefix}:${service.id}`}
        data-testid={`palette-item-${service.id}`}
        draggable
        tabIndex={0}
        onDragStart={(e) => handleDragStart(e, service.id)}
        onDoubleClick={() => handleInsertService(service.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleInsertService(service.id);
          }
        }}
        onMouseEnter={() => setHoveredService(service)}
        onFocus={() => setHoveredService(service)}
        className="group relative flex h-8 cursor-grab items-center gap-2 rounded-[6px] px-2 text-left transition-colors hover:bg-[var(--bg-raised)] focus:bg-[var(--bg-raised)] focus:outline-none active:cursor-grabbing"
      >
        <span
          className="h-3.5 w-[2px] shrink-0 rounded-full"
          style={{ backgroundColor: meta.stripeColor }}
          aria-hidden="true"
        />
        <span className="flex w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
          <ServiceIcon icon={service.icon} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">
          {service.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
          {formatLatencyShort(service.latency.p50)}
        </span>
        {providerTab === 'all' ? (
          <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--text-muted)]">
            {meta.short}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={isFav ? `Remove ${service.name} from favorites` : `Star ${service.name}`}
          onClick={(e) => {
            e.stopPropagation();
            handleToggleFavorite(service.id);
          }}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] transition-colors ${
            isFav
              ? 'text-[var(--status-warm)] opacity-100'
              : 'text-[var(--text-muted)] opacity-0 hover:text-[var(--text-primary)] group-hover:opacity-100 group-focus:opacity-100'
          }`}
        >
          <Star className="h-3 w-3" strokeWidth={1.5} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      </div>
    );
  };

  return (
    <aside
      data-testid="palette-panel"
      className="relative flex w-[272px] shrink-0 flex-col border-r border-[var(--border-hairline)] bg-[var(--bg-sunken)]"
      onMouseLeave={() => setHoveredService(null)}
    >
      {/* Search + Provider Tabs */}
      <div className="border-b border-[var(--border-hairline)] p-3">
        <div className="flex h-8 items-center gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 focus-within:border-[var(--accent)]">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
          <input
            type="text"
            aria-label="Search catalog services"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search services"
            className="w-full bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Cloud providers">
          {PROVIDER_TABS.map((tab) => {
            const active = providerTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setProviderTab(tab.id)}
                className={`h-7 rounded-[6px] px-2 text-[12px] font-medium transition-colors ${
                  active
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)] ring-1 ring-[var(--border-strong)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span className="font-mono tabular-nums">
            {totalCount} {totalCount === 1 ? 'service' : 'services'}
          </span>
          <span>Double-click or drag</span>
        </div>
      </div>

      {/* Group containers bar */}
      {onAddGroup ? (
        <div className="border-b border-[var(--border-hairline)] px-3 py-2">
          <div className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
            Add container
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ['region', 'Region'],
                ['vpc', 'VPC'],
                ['az', 'AZ'],
                ['subnet', 'Subnet'],
                ['cluster', 'Cluster'],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAddGroup(kind)}
                className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <Plus className="h-3 w-3 text-[var(--text-muted)]" strokeWidth={1.5} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Scrollable service list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {providerTab === 'custom' && customServices.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[12px] font-medium text-[var(--text-secondary)]">
              No custom services defined
            </p>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Create custom HTTP or SaaS blocks in Phase 2 to model external dependencies.
            </p>
            {onRequestCustomService ? (
              <button
                type="button"
                onClick={onRequestCustomService}
                className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>New service</span>
              </button>
            ) : null}
          </div>
        ) : totalCount === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[12px] font-medium text-[var(--text-secondary)]">No matches found</p>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Try terms like postgres, queue, cache, lambda, or llm.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {!search && favoriteServices.length > 0 ? (
              <div>
                <div className="mb-1 px-2 text-[11px] font-medium text-[var(--text-muted)]">
                  Favorites
                </div>
                <div className="space-y-0.5">
                  {favoriteServices.map((s) => renderServiceRow(s, 'fav'))}
                </div>
              </div>
            ) : null}

            {!search && recentServices.length > 0 ? (
              <div>
                <div className="mb-1 px-2 text-[11px] font-medium text-[var(--text-muted)]">
                  Recently used
                </div>
                <div className="space-y-0.5">
                  {recentServices.map((s) => renderServiceRow(s, 'rec'))}
                </div>
              </div>
            ) : null}

            {categoryGroups.map((group) => {
              const catKey = `${providerTab}:${group.category}`;
              const isCollapsed = search ? false : Boolean(collapsedCategories[catKey]);
              return (
                <div key={catKey}>
                  <button
                    type="button"
                    onClick={() => toggleCategory(catKey)}
                    className="flex h-7 w-full items-center justify-between rounded-[6px] px-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
                  >
                    <span className="flex items-center gap-1.5">
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      )}
                      <span>{group.category}</span>
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                      {group.services.length}
                    </span>
                  </button>

                  {!isCollapsed ? (
                    <div className="mt-0.5 space-y-0.5">
                      {group.services.map((service) => renderServiceRow(service, group.category))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Hover details card docked cleanly inside right edge / floating beside palette */}
      {hoveredService ? (
        <div
          data-testid="palette-hover-card"
          className="pointer-events-none absolute bottom-3 left-[calc(100%+8px)] z-30 w-72 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-floating)]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <ServiceIcon
                icon={hoveredService.icon}
                className="h-4 w-4 shrink-0 text-[var(--accent)]"
              />
              <div>
                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                  {hoveredService.name}
                </div>
                <div className="font-mono text-[11px] text-[var(--text-muted)]">
                  {hoveredService.id}
                </div>
              </div>
            </div>
            <span className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
              {hoveredService.kind}
            </span>
          </div>

          <p className="mt-2 text-[12px] leading-4 text-[var(--text-secondary)]">
            {hoveredService.description}
          </p>

          <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-[var(--border-hairline)] pt-2 text-[11px]">
            <div>
              <div className="text-[var(--text-muted)]">Latency p50 / p95</div>
              <div className="font-mono tabular-nums text-[var(--text-primary)]">
                {hoveredService.latency.p50} / {hoveredService.latency.p95} ms
              </div>
            </div>
            <div>
              <div className="text-[var(--text-muted)]">Scope</div>
              <div className="font-mono text-[var(--text-primary)]">{hoveredService.scope}</div>
            </div>
            <div className="col-span-2">
              <div className="text-[var(--text-muted)]">Capacity model</div>
              <div className="font-mono text-[var(--text-secondary)]">
                {formatCapacitySummary(hoveredService)}
              </div>
            </div>
          </div>

          <div className="mt-2 border-t border-[var(--border-hairline)] pt-1.5 text-[10px] text-[var(--text-muted)]">
            typical default — edit me in Inspector
          </div>
        </div>
      ) : null}
    </aside>
  );
}
