import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCatalog, getProviderCatalog } from '@infrasim/catalog';
import { SERVICE_ICON_PATHS } from './serviceIconMap.js';
import { groupPaletteServices } from './palette.js';

describe('T2.1 full catalog icons & palette integration', () => {
  it('maps every one of the 243 cloud provider services to an existing SVG icon on disk', () => {
    const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
    const cloudServices = [
      ...getProviderCatalog('aws'),
      ...getProviderCatalog('gcp'),
      ...getProviderCatalog('azure'),
      ...getProviderCatalog('oci'),
    ];
    expect(cloudServices).toHaveLength(243);

    const missingMappings: string[] = [];
    const missingFiles: string[] = [];

    for (const service of cloudServices) {
      const relUrl = SERVICE_ICON_PATHS[service.id];
      if (!relUrl) {
        missingMappings.push(service.id);
        continue;
      }
      const diskPath = path.join(publicDir, relUrl.replace(/^\//, ''));
      if (!fs.existsSync(diskPath)) {
        missingFiles.push(`${service.id} -> ${relUrl}`);
      }
    }

    expect(missingMappings).toEqual([]);
    expect(missingFiles).toEqual([]);
  });

  it('groups all 251 catalog services cleanly for palette browsing without dropping any row', () => {
    const allGroups = groupPaletteServices('', 'all');
    const renderedCount = allGroups.reduce((sum, g) => sum + g.services.length, 0);
    expect(renderedCount).toBe(getCatalog().length);
    expect(renderedCount).toBe(251);
  });
});
