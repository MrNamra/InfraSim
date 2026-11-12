import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'apps', 'web', 'public', 'wasm');

// Resolve WASM binaries via @infrasim/sandbox + quickjs-emscripten so pnpm strict isolation finds them.
const sandboxRequire = createRequire(path.join(repoRoot, 'packages', 'sandbox', 'package.json'));
const quickjsRequire = createRequire(sandboxRequire.resolve('quickjs-emscripten/package.json'));

interface AssetCopySpec {
  resolve: () => string;
  destFilename: string;
}

const ASSETS: AssetCopySpec[] = [
  {
    resolve: () => quickjsRequire.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'),
    destFilename: 'quickjs-release-sync.wasm',
  },
  {
    resolve: () => sandboxRequire.resolve('esbuild-wasm/esbuild.wasm'),
    destFilename: 'esbuild.wasm',
  },
];

function main(): void {
  fs.mkdirSync(outDir, { recursive: true });
  for (const asset of ASSETS) {
    const srcPath = asset.resolve();
    const destPath = path.join(outDir, asset.destFilename);
    const srcStat = fs.statSync(srcPath);
    let needsCopy = true;
    if (fs.existsSync(destPath)) {
      const destStat = fs.statSync(destPath);
      if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
        needsCopy = false;
      }
    }
    if (needsCopy) {
      fs.copyFileSync(srcPath, destPath);
      console.log(
        `Copied ${path.relative(repoRoot, destPath)} (${(srcStat.size / 1024).toFixed(1)} KB)`,
      );
    }
  }
}

main();
