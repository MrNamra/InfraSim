import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CATALOG_SERVICES } from '@infrasim/catalog';
import { ServiceIcon, getServiceIconPath } from '../components/ServiceIcon';
import { SERVICE_ICON_PATHS } from './serviceIconMap';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const SERVICES_ICON_DIR = path.join(PUBLIC_DIR, 'icons/services');

function walkSvgFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSvgFiles(full));
    } else if (entry.name.endsWith('.svg')) {
      results.push(full);
    }
  }
  return results;
}

describe('serviceIconMap & ServiceIcon', () => {
  it('maps every cloud provider service (243 total) to a valid, safe SVG asset on disk', () => {
    const cloudServices = CATALOG_SERVICES.filter((s) => s.provider !== 'generic');
    expect(cloudServices).toHaveLength(243);

    const referencedFiles = new Set<string>();

    for (const service of cloudServices) {
      const publicUrl = SERVICE_ICON_PATHS[service.id];
      expect(publicUrl, `Missing icon mapping for ${service.id}`).toBeDefined();
      if (!publicUrl) {
        continue;
      }
      expect(publicUrl.startsWith('/icons/services/')).toBe(true);
      expect(publicUrl.endsWith('.svg')).toBe(true);

      const diskPath = path.join(PUBLIC_DIR, publicUrl.slice(1));
      expect(fs.existsSync(diskPath), `Missing SVG file on disk: ${diskPath}`).toBe(true);
      referencedFiles.add(diskPath);

      const svg = fs.readFileSync(diskPath, 'utf8');
      expect(svg).toMatch(/<svg\b/);
      expect(svg).toMatch(/<\/svg>/);
      expect(svg).toMatch(/\bviewBox="[^"]+"/);
      expect(svg).not.toMatch(/<script|<foreignObject|javascript:|on[a-z]+\s*=/i);
    }

    // Ensure no orphan SVG files accumulate unused under public/icons/services
    const allDiskSvgs = walkSvgFiles(SERVICES_ICON_DIR);
    for (const file of allDiskSvgs) {
      expect(referencedFiles.has(file), `Unused icon SVG: ${file}`).toBe(true);
    }
  });

  it('keeps generic and custom services off the provider SVG map', () => {
    const genericServices = CATALOG_SERVICES.filter((s) => s.provider === 'generic');
    expect(genericServices).toHaveLength(8);

    for (const service of genericServices) {
      expect(SERVICE_ICON_PATHS[service.id]).toBeUndefined();
      expect(getServiceIconPath(service.id)).toBeUndefined();
    }

    expect(getServiceIconPath('custom.payments_webhook')).toBeUndefined();
    expect(getServiceIconPath(undefined)).toBeUndefined();
  });

  it('renders an isolated <img> for provider services and Lucide <svg> fallback for generic/custom', () => {
    const awsHtml = renderToStaticMarkup(
      createElement(ServiceIcon, { icon: 'compute', serviceId: 'aws.ec2' }),
    );
    expect(awsHtml).toContain('<img');
    expect(awsHtml).toContain('src="/icons/services/aws/ec2.svg"');
    expect(awsHtml).toContain('aria-hidden="true"');
    expect(awsHtml).toContain('draggable="false"');

    const ociHtml = renderToStaticMarkup(
      createElement(ServiceIcon, { icon: 'sql', serviceId: 'oci.autonomous_atp' }),
    );
    expect(ociHtml).toContain('src="/icons/services/oci/autonomous-atp.svg"');

    const genericHtml = renderToStaticMarkup(
      createElement(ServiceIcon, { icon: 'client', serviceId: 'generic.client' }),
    );
    expect(genericHtml).toContain('<svg');
    expect(genericHtml).not.toContain('<img');

    const fallbackHtml = renderToStaticMarkup(createElement(ServiceIcon, { icon: 'sql' }));
    expect(fallbackHtml).toContain('<svg');
    expect(fallbackHtml).not.toContain('<img');
  });
});
