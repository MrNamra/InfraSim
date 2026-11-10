import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import {
  formatCapacitySummary,
  formatLatencyShort,
  groupPaletteServices,
  pushRecentServiceId,
  resolveStoredServices,
  toggleFavoriteServiceId,
} from './palette';

describe('palette helpers', () => {
  it('groups filtered services by category for each provider tab', () => {
    const awsGroups = groupPaletteServices('', 'aws');
    const awsTotal = awsGroups.reduce((sum, g) => sum + g.services.length, 0);
    expect(awsTotal).toBe(77);
    expect(awsGroups.map((g) => g.category)).toContain('Compute');
    expect(awsGroups.map((g) => g.category)).toContain('AI & ML');

    const genericGroups = groupPaletteServices('', 'generic');
    const genericTotal = genericGroups.reduce((sum, g) => sum + g.services.length, 0);
    expect(genericTotal).toBe(8);
  });

  it('searches across aliases and tags consistently', () => {
    const cacheGroups = groupPaletteServices('cache', 'all');
    const allIds = cacheGroups.flatMap((g) => g.services.map((s) => s.id));
    expect(allIds).toContain('aws.elasticache_redis');
    expect(allIds).toContain('gcp.memorystore_redis');
    expect(allIds).toContain('generic.cache');
  });

  it('formats latencies and capacity specs consistently', () => {
    expect(formatLatencyShort(0)).toBe('0 ms');
    expect(formatLatencyShort(0.5)).toBe('~0.5 ms');
    expect(formatLatencyShort(15)).toBe('~15 ms');
    expect(formatLatencyShort(2500)).toBe('~2.5 s');
    expect(formatLatencyShort(120000)).toBe('~2 min');
    expect(formatLatencyShort(10800000)).toBe('~3 hr');

    const lambda = getService('aws.lambda');
    expect(lambda).toBeDefined();
    if (lambda) {
      expect(formatCapacitySummary(lambda)).toContain('1000 concurrent');
    }
  });

  it('updates favorites and bounded recent lists deterministically', () => {
    let favs = toggleFavoriteServiceId([], 'aws.ec2');
    favs = toggleFavoriteServiceId(favs, 'aws.s3');
    expect(favs).toEqual(['aws.ec2', 'aws.s3']);
    favs = toggleFavoriteServiceId(favs, 'aws.ec2');
    expect(favs).toEqual(['aws.s3']);

    let recent: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'b']) {
      recent = pushRecentServiceId(recent, id);
    }
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe('b');

    const resolved = resolveStoredServices(['aws.s3', 'does.not.exist', 'generic.lb']);
    expect(resolved.map((s) => s.id)).toEqual(['aws.s3', 'generic.lb']);
  });
});
