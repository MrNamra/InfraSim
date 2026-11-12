/** List of allow-listed external npm specifiers available to guest code in the sandbox. */
export const ALLOWED_SANDBOX_MODULES = [
  'uuid',
  'lodash',
  'lodash-es',
  'dayjs',
  'zod',
  'ajv',
  'axios',
  'node-fetch',
  '@aws-sdk/client-*',
  '@aws-sdk/lib-dynamodb',
  '@aws-sdk/client-bedrock-runtime',
  '@google-cloud/storage',
  '@google-cloud/pubsub',
  '@google-cloud/firestore',
  '@google-cloud/secret-manager',
  '@google-cloud/vertexai',
  '@azure/storage-blob',
  '@azure/cosmos',
  '@azure/service-bus',
  '@azure/keyvault-secrets',
  'openai',
  'oci-objectstorage',
  'oci-generativeaiinference',
  'oci-queue',
  'oci-common',
  'k6',
  'k6/http',
] as const;

const RESTRICTED_SIMULATOR_BUILTINS = new Set([
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster',
  'dns',
  'node:dns',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
  'os',
  'node:os',
]);

const ALLOWED_SAFE_BUILTINS = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'url',
  'node:url',
  'crypto',
  'node:crypto',
  'buffer',
  'node:buffer',
  'util',
  'node:util',
]);

export function isRestrictedBuiltin(specifier: string): boolean {
  return RESTRICTED_SIMULATOR_BUILTINS.has(specifier);
}

export function isSafeBuiltin(specifier: string): boolean {
  return ALLOWED_SAFE_BUILTINS.has(specifier);
}

export function isAllowedAllowlistPackage(specifier: string): boolean {
  if (
    specifier === 'uuid' ||
    specifier === 'lodash' ||
    specifier === 'lodash-es' ||
    specifier === 'dayjs' ||
    specifier === 'zod' ||
    specifier === 'ajv' ||
    specifier === 'axios' ||
    specifier === 'node-fetch' ||
    specifier === 'openai' ||
    specifier === '@aws-sdk/lib-dynamodb' ||
    specifier === '@aws-sdk/client-bedrock-runtime' ||
    specifier === '@google-cloud/storage' ||
    specifier === '@google-cloud/pubsub' ||
    specifier === '@google-cloud/firestore' ||
    specifier === '@google-cloud/secret-manager' ||
    specifier === '@google-cloud/vertexai' ||
    specifier === '@azure/storage-blob' ||
    specifier === '@azure/cosmos' ||
    specifier === '@azure/service-bus' ||
    specifier === '@azure/keyvault-secrets' ||
    specifier === 'oci-objectstorage' ||
    specifier === 'oci-generativeaiinference' ||
    specifier === 'oci-queue' ||
    specifier === 'oci-common' ||
    specifier === 'k6' ||
    specifier === 'k6/http'
  ) {
    return true;
  }
  if (/^@aws-sdk\/client-[a-z0-9-]+$/.test(specifier)) {
    return true;
  }
  if (/^lodash\/[a-zA-Z0-9_-]+$/.test(specifier)) {
    return true;
  }
  if (/^dayjs\/plugin\/[a-zA-Z0-9_-]+$/.test(specifier)) {
    return true;
  }
  return false;
}

/** Builds pure-JS virtual module source code for safe builtins and utility allow-list packages. */
export function generateVirtualUtilityModule(specifier: string): string | null {
  if (isRestrictedBuiltin(specifier)) {
    const cleanName = specifier.replace(/^node:/, '');
    return `
const throwUnsupported = () => {
  if (typeof globalThis.__infrasimUnsupported === 'function') {
    globalThis.__infrasimUnsupported(${JSON.stringify(cleanName)});
  }
  throw new Error(${JSON.stringify(cleanName + ' is not available in the simulator')});
};
const proxy = new Proxy(function() { throwUnsupported(); }, {
  get(_t, prop) {
    if (prop === '__esModule' || prop === Symbol.toStringTag) return undefined;
    return () => throwUnsupported();
  },
  construct() { throwUnsupported(); },
  apply() { throwUnsupported(); },
});
export default proxy;
export const createServer = () => throwUnsupported();
export const request = () => throwUnsupported();
export const connect = () => throwUnsupported();
export const spawn = () => throwUnsupported();
export const exec = () => throwUnsupported();
export const execSync = () => throwUnsupported();
`;
  }

  if (specifier === 'k6') {
    return `
export const check = (...args) => globalThis.check?.(...args) ?? true;
export const sleep = (...args) => globalThis.sleep?.(...args);
export const group = (...args) => globalThis.group?.(...args);
export default { check, sleep, group };
`;
  }

  if (specifier === 'k6/http') {
    return `
const httpProxy = new Proxy({}, {
  get(_t, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return httpProxy;
    return (...args) => globalThis.http?.[prop]?.(...args);
  },
});
export const get = (...args) => globalThis.http?.get(...args);
export const post = (...args) => globalThis.http?.post(...args);
export const put = (...args) => globalThis.http?.put(...args);
export const del = (...args) => globalThis.http?.del(...args);
export const patch = (...args) => globalThis.http?.patch(...args);
export default httpProxy;
`;
  }

  if (specifier === 'fs' || specifier === 'node:fs') {
    return `
const fsApi = globalThis.__infrasimFs;
export const readFileSync = (...a) => fsApi.readFileSync(...a);
export const writeFileSync = (...a) => fsApi.writeFileSync(...a);
export const existsSync = (...a) => fsApi.existsSync(...a);
export const unlinkSync = (...a) => fsApi.unlinkSync(...a);
export const mkdirSync = (...a) => fsApi.mkdirSync(...a);
export const promises = {
  readFile: async (...a) => fsApi.readFileSync(...a),
  writeFile: async (...a) => fsApi.writeFileSync(...a),
  unlink: async (...a) => fsApi.unlinkSync(...a),
  mkdir: async (...a) => fsApi.mkdirSync(...a),
};
export default { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, promises };
`;
  }

  if (specifier === 'fs/promises' || specifier === 'node:fs/promises') {
    return `
const fsApi = globalThis.__infrasimFs;
export const readFile = async (...a) => fsApi.readFileSync(...a);
export const writeFile = async (...a) => fsApi.writeFileSync(...a);
export const unlink = async (...a) => fsApi.unlinkSync(...a);
export const mkdir = async (...a) => fsApi.mkdirSync(...a);
export default { readFile, writeFile, unlink, mkdir };
`;
  }

  if (specifier === 'path' || specifier === 'node:path') {
    return `
export const sep = '/';
export function normalize(p) {
  const parts = String(p || '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (String(p).startsWith('/') ? '/' : '') + out.join('/');
}
export function join(...parts) { return normalize(parts.filter(Boolean).join('/')); }
export function resolve(...parts) { return normalize('/' + parts.filter(Boolean).join('/')); }
export function dirname(p) {
  const idx = String(p).lastIndexOf('/');
  if (idx <= 0) return idx === 0 ? '/' : '.';
  return String(p).slice(0, idx);
}
export function basename(p, ext) {
  const clean = String(p).replace(/\\/+$/, '');
  const idx = clean.lastIndexOf('/');
  const base = idx >= 0 ? clean.slice(idx + 1) : clean;
  return ext && base.endsWith(ext) ? base.slice(0, base.length - ext.length) : base;
}
export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
}
export default { sep, normalize, join, resolve, dirname, basename, extname };
`;
  }

  if (specifier === 'url' || specifier === 'node:url') {
    return `
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export default { URL, URLSearchParams };
`;
  }

  if (specifier === 'crypto' || specifier === 'node:crypto') {
    return `
export const randomUUID = () => globalThis.crypto.randomUUID();
export const getRandomValues = (arr) => globalThis.crypto.getRandomValues(arr);
export default { randomUUID, getRandomValues };
`;
  }

  if (specifier === 'buffer' || specifier === 'node:buffer') {
    return `
export const Buffer = globalThis.Buffer;
export default { Buffer };
`;
  }

  if (specifier === 'util' || specifier === 'node:util') {
    return `
export function format(fmt, ...args) {
  if (typeof fmt !== 'string') return [fmt, ...args].map(String).join(' ');
  let idx = 0;
  return fmt.replace(/%[sdj]/g, (m) => idx < args.length ? (m === '%j' ? JSON.stringify(args[idx++]) : String(args[idx++])) : m);
}
export function promisify(fn) {
  return (...args) => new Promise((resolve, reject) => fn(...args, (e, v) => e ? reject(e) : resolve(v)));
}
export default { format, promisify };
`;
  }

  if (specifier === 'uuid') {
    return `
export const NIL = '00000000-0000-0000-0000-000000000000';
export function v4() { return globalThis.crypto.randomUUID(); }
export function v1() { return globalThis.crypto.randomUUID(); }
export function v7() { return globalThis.crypto.randomUUID(); }
export function validate(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
export function version(s) {
  if (!validate(s)) throw new TypeError('Invalid UUID');
  return parseInt(s[14], 16);
}
export default { NIL, v4, v1, v7, validate, version };
`;
  }

  if (specifier === 'lodash' || specifier === 'lodash-es' || specifier.startsWith('lodash/')) {
    const core = `
function toPath(p) {
  if (Array.isArray(p)) return p;
  return String(p || '').replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
}
export function get(obj, path, def) {
  let cur = obj;
  for (const key of toPath(path)) {
    if (cur == null || typeof cur !== 'object') return def;
    cur = cur[key];
  }
  return cur === undefined ? def : cur;
}
export function set(obj, path, val) {
  if (!obj || typeof obj !== 'object') return obj;
  const parts = toPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = /^\\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[k];
  }
  if (parts.length > 0) cur[parts[parts.length - 1]] = val;
  return obj;
}
export function has(obj, path) {
  let cur = obj;
  for (const key of toPath(path)) {
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}
export function pick(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const k of [].concat(keys)) if (k in obj) out[k] = obj[k];
  return out;
}
export function omit(obj, keys) {
  const skip = new Set([].concat(keys));
  const out = {};
  if (!obj) return out;
  for (const k of Object.keys(obj)) if (!skip.has(k)) out[k] = obj[k];
  return out;
}
export function cloneDeep(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (v instanceof Date) return new Date(v.getTime());
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneDeep(v[k]);
  return out;
}
export function merge(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        target[k] = merge(target[k] && typeof target[k] === 'object' ? target[k] : {}, src[k]);
      } else {
        target[k] = src[k];
      }
    }
  }
  return target;
}
export function uniq(arr) { return Array.from(new Set(arr || [])); }
export function uniqBy(arr, fn) {
  const getKey = typeof fn === 'function' ? fn : (x) => get(x, fn);
  const seen = new Set();
  return (arr || []).filter((x) => {
    const k = getKey(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
export function groupBy(arr, fn) {
  const getKey = typeof fn === 'function' ? fn : (x) => get(x, fn);
  const out = {};
  for (const item of arr || []) {
    const k = String(getKey(item));
    (out[k] ||= []).push(item);
  }
  return out;
}
export function keyBy(arr, fn) {
  const getKey = typeof fn === 'function' ? fn : (x) => get(x, fn);
  const out = {};
  for (const item of arr || []) out[String(getKey(item))] = item;
  return out;
}
export function chunk(arr, size = 1) {
  const n = Math.max(1, Math.trunc(size));
  const out = [];
  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
export function flatten(arr) { return (arr || []).flat(1); }
export function flattenDeep(arr) { return (arr || []).flat(Infinity); }
export function compact(arr) { return (arr || []).filter(Boolean); }
export function sumBy(arr, fn) {
  const getter = typeof fn === 'function' ? fn : fn ? (x) => get(x, fn, 0) : (x) => x;
  return (arr || []).reduce((acc, x) => acc + (Number(getter(x)) || 0), 0);
}
export function sum(arr) { return sumBy(arr); }
export function sortBy(arr, fn) {
  const getter = typeof fn === 'function' ? fn : (x) => get(x, fn);
  return [...(arr || [])].sort((a, b) => {
    const va = getter(a), vb = getter(b);
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
}
export function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return true;
}
export function isEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
export function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = fn(v, k, obj);
  return out;
}
export function camelCase(s) {
  return String(s || '').replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}
export function snakeCase(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().replace(/^_|_$/g, '');
}
export function kebabCase(s) { return snakeCase(s).replace(/_/g, '-'); }
export function debounce(fn, wait = 0) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
export function throttle(fn) { return (...args) => fn(...args); }
`;
    if (specifier.startsWith('lodash/')) {
      const fnName = specifier.slice('lodash/'.length);
      return `${core}\nexport default ${fnName};\n`;
    }
    return `
${core}
const _exports = {
  get, set, has, pick, omit, cloneDeep, merge, uniq, uniqBy, groupBy, keyBy,
  chunk, flatten, flattenDeep, compact, sumBy, sum, sortBy, isEmpty, isEqual,
  clamp, mapValues, camelCase, snakeCase, kebabCase, debounce, throttle
};
function lodash(val) {
  return {
    value: () => val,
    map: (fn) => lodash((val || []).map(fn)),
    filter: (fn) => lodash((val || []).filter(fn)),
    uniq: () => lodash(uniq(val)),
    groupBy: (fn) => lodash(groupBy(val, fn)),
    sortBy: (fn) => lodash(sortBy(val, fn)),
    pick: (k) => lodash(pick(val, k)),
    omit: (k) => lodash(omit(val, k)),
  };
}
Object.assign(lodash, _exports);
export default lodash;
`;
  }

  if (specifier === 'dayjs' || specifier.startsWith('dayjs/plugin/')) {
    if (specifier.startsWith('dayjs/plugin/')) {
      return `export default function plugin(_opt, _Dayjs) {}\n`;
    }
    return `
const UNIT_MS = {
  millisecond: 1, ms: 1,
  second: 1000, s: 1000,
  minute: 60000, m: 60000,
  hour: 3600000, h: 3600000,
  day: 86400000, d: 86400000,
  week: 604800000, w: 604800000,
};
class SimDayjs {
  constructor(input) {
    this._d = input instanceof Date ? new Date(input.getTime())
      : input instanceof SimDayjs ? new Date(input._d.getTime())
      : input === undefined ? new Date()
      : new Date(input);
  }
  valueOf() { return this._d.getTime(); }
  unix() { return Math.floor(this._d.getTime() / 1000); }
  toDate() { return new Date(this._d.getTime()); }
  toISOString() { return this._d.toISOString(); }
  isValid() { return !Number.isNaN(this._d.getTime()); }
  add(amount, unit = 'ms') {
    const u = String(unit).toLowerCase().replace(/s$/, '');
    const mult = UNIT_MS[u];
    if (mult) return new SimDayjs(this._d.getTime() + Number(amount) * mult);
    const d = this.toDate();
    if (u === 'month') d.setUTCMonth(d.getUTCMonth() + Number(amount));
    else if (u === 'year') d.setUTCFullYear(d.getUTCFullYear() + Number(amount));
    return new SimDayjs(d);
  }
  subtract(amount, unit) { return this.add(-Number(amount), unit); }
  startOf(unit) {
    const u = String(unit).toLowerCase();
    const d = this.toDate();
    if (u === 'day' || u === 'd') d.setUTCHours(0, 0, 0, 0);
    else if (u === 'hour' || u === 'h') d.setUTCMinutes(0, 0, 0);
    else if (u === 'minute' || u === 'm') d.setUTCSeconds(0, 0);
    return new SimDayjs(d);
  }
  endOf(unit) {
    const u = String(unit).toLowerCase();
    const d = this.toDate();
    if (u === 'day' || u === 'd') d.setUTCHours(23, 59, 59, 999);
    else if (u === 'hour' || u === 'h') d.setUTCMinutes(59, 59, 999);
    else if (u === 'minute' || u === 'm') d.setUTCSeconds(59, 999);
    return new SimDayjs(d);
  }
  diff(other, unit = 'ms') {
    const delta = this.valueOf() - dayjs(other).valueOf();
    const u = String(unit).toLowerCase().replace(/s$/, '');
    return UNIT_MS[u] ? Math.trunc(delta / UNIT_MS[u]) : delta;
  }
  isBefore(other) { return this.valueOf() < dayjs(other).valueOf(); }
  isAfter(other) { return this.valueOf() > dayjs(other).valueOf(); }
  isSame(other) { return this.valueOf() === dayjs(other).valueOf(); }
  format(fmt = 'YYYY-MM-DDTHH:mm:ss.SSSZ') {
    const d = this._d;
    const p2 = (n) => String(n).padStart(2, '0');
    const p3 = (n) => String(n).padStart(3, '0');
    return String(fmt)
      .replace(/YYYY/g, String(d.getUTCFullYear()))
      .replace(/MM/g, p2(d.getUTCMonth() + 1))
      .replace(/DD/g, p2(d.getUTCDate()))
      .replace(/HH/g, p2(d.getUTCHours()))
      .replace(/mm/g, p2(d.getUTCMinutes()))
      .replace(/ss/g, p2(d.getUTCSeconds()))
      .replace(/SSS/g, p3(d.getUTCMilliseconds()))
      .replace(/Z/g, 'Z');
  }
}
function dayjs(input) { return new SimDayjs(input); }
dayjs.unix = (s) => new SimDayjs(Number(s) * 1000);
dayjs.extend = () => dayjs;
dayjs.utc = (input) => new SimDayjs(input);
export default dayjs;
`;
  }

  if (specifier === 'zod') {
    return `
export class ZodError extends Error {
  constructor(issues) {
    super(issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    this.name = 'ZodError';
    this.issues = issues;
  }
}
class BaseSchema {
  constructor(checkFn) { this._check = checkFn; this._def = {}; }
  optional() { return new BaseSchema((v, path) => v === undefined ? { ok: true, data: undefined } : this._check(v, path)); }
  nullable() { return new BaseSchema((v, path) => v === null ? { ok: true, data: null } : this._check(v, path)); }
  default(defVal) {
    return new BaseSchema((v, path) => v === undefined
      ? { ok: true, data: typeof defVal === 'function' ? defVal() : defVal }
      : this._check(v, path));
  }
  refine(pred, msg = 'Invalid value') {
    return new BaseSchema((v, path) => {
      const r = this._check(v, path);
      if (!r.ok) return r;
      return pred(r.data) ? r : { ok: false, issues: [{ path, message: msg }] };
    });
  }
  safeParse(val) {
    const r = this._check(val, []);
    return r.ok ? { success: true, data: r.data } : { success: false, error: new ZodError(r.issues) };
  }
  parse(val) {
    const r = this.safeParse(val);
    if (!r.success) throw r.error;
    return r.data;
  }
}
class StringSchema extends BaseSchema {
  constructor(rules = []) {
    super((v, path) => {
      if (typeof v !== 'string') return { ok: false, issues: [{ path, message: 'Expected string' }] };
      for (const r of rules) { const err = r(v); if (err) return { ok: false, issues: [{ path, message: err }] }; }
      return { ok: true, data: v };
    });
    this._rules = rules;
  }
  min(n) { return new StringSchema([...this._rules, (v) => v.length < n ? 'Min length ' + n : null]); }
  max(n) { return new StringSchema([...this._rules, (v) => v.length > n ? 'Max length ' + n : null]); }
  email() { return new StringSchema([...this._rules, (v) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v) ? null : 'Invalid email']); }
  uuid() { return new StringSchema([...this._rules, (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? null : 'Invalid uuid']); }
  url() { return new StringSchema([...this._rules, (v) => /^https?:\\/\\//.test(v) ? null : 'Invalid url']); }
  regex(re) { return new StringSchema([...this._rules, (v) => re.test(v) ? null : 'Regex mismatch']); }
}
class NumberSchema extends BaseSchema {
  constructor(rules = []) {
    super((v, path) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, issues: [{ path, message: 'Expected number' }] };
      for (const r of rules) { const err = r(v); if (err) return { ok: false, issues: [{ path, message: err }] }; }
      return { ok: true, data: v };
    });
    this._rules = rules;
  }
  int() { return new NumberSchema([...this._rules, (v) => Number.isInteger(v) ? null : 'Expected integer']); }
  min(n) { return new NumberSchema([...this._rules, (v) => v < n ? 'Must be >= ' + n : null]); }
  max(n) { return new NumberSchema([...this._rules, (v) => v > n ? 'Must be <= ' + n : null]); }
  positive() { return new NumberSchema([...this._rules, (v) => v > 0 ? null : 'Must be > 0']); }
  nonnegative() { return new NumberSchema([...this._rules, (v) => v >= 0 ? null : 'Must be >= 0']); }
}
export const z = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BaseSchema((v, path) => typeof v === 'boolean' ? { ok: true, data: v } : { ok: false, issues: [{ path, message: 'Expected boolean' }] }),
  any: () => new BaseSchema((v) => ({ ok: true, data: v })),
  unknown: () => new BaseSchema((v) => ({ ok: true, data: v })),
  literal: (val) => new BaseSchema((v, path) => v === val ? { ok: true, data: v } : { ok: false, issues: [{ path, message: 'Expected literal ' + JSON.stringify(val) }] }),
  enum: (vals) => new BaseSchema((v, path) => vals.includes(v) ? { ok: true, data: v } : { ok: false, issues: [{ path, message: 'Invalid enum value' }] }),
  array: (itemSchema) => new BaseSchema((v, path) => {
    if (!Array.isArray(v)) return { ok: false, issues: [{ path, message: 'Expected array' }] };
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const r = itemSchema._check(v[i], [...path, i]);
      if (!r.ok) return r;
      out.push(r.data);
    }
    return { ok: true, data: out };
  }),
  object: (shape) => new BaseSchema((v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, issues: [{ path, message: 'Expected object' }] };
    const out = { ...v };
    const issues = [];
    for (const [k, s] of Object.entries(shape)) {
      const r = s._check(v[k], [...path, k]);
      if (!r.ok) issues.push(...r.issues);
      else if (r.data !== undefined) out[k] = r.data;
    }
    return issues.length ? { ok: false, issues } : { ok: true, data: out };
  }),
  record: (valSchema) => new BaseSchema((v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, issues: [{ path, message: 'Expected object' }] };
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const r = valSchema._check(val, [...path, k]);
      if (!r.ok) return r;
      out[k] = r.data;
    }
    return { ok: true, data: out };
  }),
  union: (schemas) => new BaseSchema((v, path) => {
    for (const s of schemas) { const r = s._check(v, path); if (r.ok) return r; }
    return { ok: false, issues: [{ path, message: 'Invalid union input' }] };
  }),
};
export default z;
`;
  }

  if (specifier === 'ajv') {
    return `
function validateSchemaNode(schema, val, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((t) => {
      if (t === 'array') return Array.isArray(val);
      if (t === 'null') return val === null;
      if (t === 'integer') return typeof val === 'number' && Number.isInteger(val);
      if (t === 'object') return typeof val === 'object' && val !== null && !Array.isArray(val);
      return typeof val === t;
    });
    if (!ok) { errors.push({ instancePath: path, message: 'must be ' + allowed.join(',') }); return; }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((c) => JSON.stringify(c) === JSON.stringify(val))) {
    errors.push({ instancePath: path, message: 'must match enum' });
  }
  if (typeof val === 'string') {
    if (typeof schema.minLength === 'number' && val.length < schema.minLength) errors.push({ instancePath: path, message: 'must NOT have fewer than ' + schema.minLength + ' characters' });
    if (typeof schema.maxLength === 'number' && val.length > schema.maxLength) errors.push({ instancePath: path, message: 'must NOT have more than ' + schema.maxLength + ' characters' });
  }
  if (typeof val === 'number') {
    if (typeof schema.minimum === 'number' && val < schema.minimum) errors.push({ instancePath: path, message: 'must be >= ' + schema.minimum });
    if (typeof schema.maximum === 'number' && val > schema.maximum) errors.push({ instancePath: path, message: 'must be <= ' + schema.maximum });
  }
  if (Array.isArray(val) && schema.items) {
    val.forEach((item, idx) => validateSchemaNode(schema.items, item, path + '/' + idx, errors));
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in val)) errors.push({ instancePath: path, message: "must have required property '" + k + "'" });
      }
    }
    if (schema.properties) {
      for (const [k, s] of Object.entries(schema.properties)) {
        if (k in val) validateSchemaNode(s, val[k], path + '/' + k, errors);
      }
    }
  }
}
export default class Ajv {
  constructor(opts = {}) { this.opts = opts; this.errors = null; }
  compile(schema) {
    const fn = (data) => {
      const errs = [];
      validateSchemaNode(schema, data, '', errs);
      fn.errors = errs.length > 0 ? errs : null;
      this.errors = fn.errors;
      return errs.length === 0;
    };
    fn.errors = null;
    return fn;
  }
}
`;
  }

  return null;
}

/** Temporary lightweight SDK/HTTP shims overridden cleanly by full T3.3/T3.4 shims when installed. */
export function generateVirtualSdkFallbackModule(specifier: string): string | null {
  if (specifier === 'axios') {
    return `
async function request(cfg) {
  try {
    const res = await globalThis.__infrasimInvokeSdk({
      kind: 'http',
      sdkStyle: 'http',
      method: String(cfg?.method || 'GET').toUpperCase(),
      url: String(cfg?.url || ''),
      headers: cfg?.headers || {},
      body: cfg?.data,
    });
    const status = typeof res?.statusCode === 'number' ? res.statusCode : 200;
    const data = res?.body !== undefined ? (() => { try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; } catch { return res.body; } })() : res;
    if (status >= 400) {
      const err = new Error('Request failed with status code ' + status);
      err.isAxiosError = true;
      err.status = status;
      err.response = { status, data, headers: res?.headers || {} };
      throw err;
    }
    return {
      data,
      status,
      statusText: status < 300 ? 'OK' : 'Error',
      headers: res?.headers || {},
    };
  } catch (err) {
    if (err && typeof err === 'object' && !err.isAxiosError) {
      err.isAxiosError = true;
      if (!err.response) {
        err.response = { status: err.statusCode || 500, data: { message: err.message, code: err.code } };
      }
    }
    throw err;
  }
}
const axios = Object.assign(request, {
  request,
  get: (url, cfg = {}) => request({ ...cfg, method: 'GET', url }),
  delete: (url, cfg = {}) => request({ ...cfg, method: 'DELETE', url }),
  post: (url, data, cfg = {}) => request({ ...cfg, method: 'POST', url, data }),
  put: (url, data, cfg = {}) => request({ ...cfg, method: 'PUT', url, data }),
  patch: (url, data, cfg = {}) => request({ ...cfg, method: 'PATCH', url, data }),
  create: (defaults = {}) => ({
    get: (url, cfg = {}) => request({ ...defaults, ...cfg, method: 'GET', url: (defaults.baseURL || '') + url }),
    post: (url, data, cfg = {}) => request({ ...defaults, ...cfg, method: 'POST', url: (defaults.baseURL || '') + url, data }),
    put: (url, data, cfg = {}) => request({ ...defaults, ...cfg, method: 'PUT', url: (defaults.baseURL || '') + url, data }),
    delete: (url, cfg = {}) => request({ ...defaults, ...cfg, method: 'DELETE', url: (defaults.baseURL || '') + url }),
  }),
});
export default axios;
`;
  }

  if (specifier === 'node-fetch') {
    return `export default globalThis.fetch;\nexport const Headers = globalThis.Headers;\nexport const Request = globalThis.Request;\nexport const Response = globalThis.Response;\n`;
  }

  if (
    specifier.startsWith('@aws-sdk/') ||
    specifier.startsWith('@google-cloud/') ||
    specifier.startsWith('@azure/') ||
    specifier === 'openai' ||
    specifier.startsWith('oci-')
  ) {
    // Detailed per-command shims live in cloudSdks.ts (T3.4); baseline proxy keeps T3.2 standalone bundling clean.
    return `
const pkgName = ${JSON.stringify(specifier)};
const clientProxy = new Proxy({}, {
  get(_t, prop) {
    if (prop === '__esModule') return true;
    const name = String(prop);
    if (name.endsWith('Command')) {
      return class GenericCommand {
        constructor(input = {}) {
          this.input = input;
          this.__op = name.replace(/Command$/, '');
        }
      };
    }
    return class GenericClient {
      constructor(cfg = {}) { this.cfg = cfg; }
      async send(cmd) {
        return globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'aws-v3',
          serviceId: pkgName,
          op: cmd?.__op || cmd?.constructor?.name?.replace(/Command$/, '') || 'Call',
          input: cmd?.input ?? cmd ?? {},
          region: this.cfg?.region,
        });
      }
    };
  },
});
export default clientProxy;
`;
  }

  return null;
}
