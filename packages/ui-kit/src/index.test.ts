import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_KIT_VERSION } from './index.js';

describe('@infrasim/ui-kit theme and components', () => {
  it('exports package version', () => {
    expect(UI_KIT_VERSION).toBe('0.1.0');
  });

  it('defines Graphite dark and light themes and reduced-motion rules', () => {
    const cssPath = path.resolve(import.meta.dirname, 'styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain("[data-theme='light']");
    expect(css).toContain('--status-overloaded');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.infrasim-motion-safe');
  });
});
