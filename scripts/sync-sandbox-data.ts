import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = path.join(rootDir, 'packages/sandbox/data/payload_doctor_rules.json');
const outTsPath = path.join(rootDir, 'packages/sandbox/src/generated/payloadDoctorRules.ts');

const raw = fs.readFileSync(jsonPath, 'utf8');
const parsed = JSON.parse(raw) as unknown;

const content = `// Auto-generated from packages/sandbox/data/payload_doctor_rules.json by scripts/sync-sandbox-data.ts
import type { PayloadDoctorRule } from '../types.js';

export const PAYLOAD_DOCTOR_RULES: PayloadDoctorRule[] = ${JSON.stringify(parsed, null, 2)} as PayloadDoctorRule[];
`;

fs.mkdirSync(path.dirname(outTsPath), { recursive: true });
fs.writeFileSync(outTsPath, content, 'utf8');
console.log(
  `Synced ${Array.isArray(parsed) ? parsed.length : 0} Payload Doctor rules -> ${path.relative(rootDir, outTsPath)}`,
);
