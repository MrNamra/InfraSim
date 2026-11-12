export interface GuestPreludeOptions {
  baseEpochMs: number;
  env: Record<string, string>;
  tmpFsMaxBytes: number;
  memoryLimitBytes: number;
  discoveryMode: boolean;
}

/**
 * Generates the deterministic sandbox prelude injected inside QuickJS prior to user code.
 * Exchanges data with the host strictly over serialized JSON/primitive FFI callbacks.
 */
export function buildGuestPrelude(opts: GuestPreludeOptions): string {
  const baseEpoch = Math.floor(opts.baseEpochMs);
  const envJson = JSON.stringify(opts.env);
  const maxTmp = Math.max(1024, Math.floor(opts.tmpFsMaxBytes));
  const maxMemBytes = Math.max(1024 * 1024, Math.floor(opts.memoryLimitBytes));
  const discoveryFlag = opts.discoveryMode ? 'true' : 'false';

  return `
;(function() {
  const __global = globalThis;
  const __RealDate = Date;
  const __MAX_GUEST_MEM_BYTES = ${maxMemBytes};
  let __trackedTypedBytes = 0;
  function __guardTypedAlloc(byteLen) {
    if (byteLen > __MAX_GUEST_MEM_BYTES || __trackedTypedBytes + byteLen > __MAX_GUEST_MEM_BYTES) {
      throw new RangeError('Out of memory: guest buffer limit exceeded');
    }
    __trackedTypedBytes += byteLen;
  }
  const __OrigArrayBuffer = ArrayBuffer;
  __global.ArrayBuffer = new Proxy(__OrigArrayBuffer, {
    construct(Target, args, newTarget) {
      const len = Number(args[0]) || 0;
      __guardTypedAlloc(len);
      return Reflect.construct(Target, args, newTarget);
    },
  });
  for (const [CtorName, BPE] of [
    ['Uint8Array', 1], ['Int8Array', 1], ['Uint8ClampedArray', 1],
    ['Uint16Array', 2], ['Int16Array', 2],
    ['Uint32Array', 4], ['Int32Array', 4],
    ['Float32Array', 4], ['Float64Array', 8],
    ['BigInt64Array', 8], ['BigUint64Array', 8],
  ]) {
    const OrigTA = __global[CtorName];
    if (typeof OrigTA === 'function') {
      __global[CtorName] = new Proxy(OrigTA, {
        construct(Target, args, newTarget) {
          if (typeof args[0] === 'number') {
            __guardTypedAlloc(args[0] * BPE);
          }
          return Reflect.construct(Target, args, newTarget);
        },
      });
    }
  }
  const __hostNow = __global.__infrasimNowMs;
  const __hostRand = __global.__infrasimRandom;
  const __hostUuid = __global.__infrasimRandomUuid;
  const __hostLog = __global.__infrasimLog;
  const __hostTimerSched = __global.__infrasimScheduleTimer;
  const __hostTimerClear = __global.__infrasimClearTimer;
  const __hostMockCall = __global.__infrasimMockCall;
  const __hostRecordDiscovery = __global.__infrasimRecordDiscovery;
  const __baseEpochMs = ${baseEpoch};
  const __discoveryMode = ${discoveryFlag};

  // Virtual Date & performance.now()
  function VirtualDate(...args) {
    if (!(this instanceof VirtualDate)) {
      return new __RealDate(__baseEpochMs + __hostNow()).toUTCString();
    }
    if (args.length === 0) {
      return new __RealDate(__baseEpochMs + __hostNow());
    }
    return new __RealDate(...args);
  }
  VirtualDate.now = () => __baseEpochMs + Math.round(__hostNow());
  VirtualDate.UTC = __RealDate.UTC;
  VirtualDate.parse = __RealDate.parse;
  VirtualDate.prototype = __RealDate.prototype;
  __global.Date = VirtualDate;

  __global.performance = {
    now: () => __hostNow(),
    timeOrigin: __baseEpochMs,
  };

  // Seeded randomness
  Math.random = () => __hostRand();
  __global.crypto = {
    randomUUID: () => __hostUuid(),
    getRandomValues: (arr) => {
      if (!arr || typeof arr.length !== 'number') {
        throw new TypeError('Expected TypedArray for crypto.getRandomValues');
      }
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(__hostRand() * 256);
      }
      return arr;
    },
  };

  // Virtual timers (driven deterministically by host event loop)
  const __timers = new Map();
  __global.__infrasimFireTimer = function(id) {
    const entry = __timers.get(id);
    if (!entry) return;
    if (!entry.repeat) {
      __timers.delete(id);
    }
    entry.fn(...entry.args);
  };

  __global.setTimeout = function(fn, delay, ...args) {
    if (typeof fn !== 'function') throw new TypeError('setTimeout requires a function');
    const ms = Math.max(0, Number(delay) || 0);
    const id = __hostTimerSched(ms, false);
    __timers.set(id, { fn, args, repeat: false });
    return id;
  };
  __global.clearTimeout = function(id) {
    __timers.delete(id);
    __hostTimerClear(Number(id) || 0);
  };
  __global.setInterval = function(fn, delay, ...args) {
    if (typeof fn !== 'function') throw new TypeError('setInterval requires a function');
    const ms = Math.max(1, Number(delay) || 1);
    const id = __hostTimerSched(ms, true);
    __timers.set(id, { fn, args, repeat: true });
    return id;
  };
  __global.clearInterval = __global.clearTimeout;
  __global.setImmediate = function(fn, ...args) {
    return __global.setTimeout(fn, 0, ...args);
  };
  __global.clearImmediate = __global.clearTimeout;
  __global.sleep = function(ms) {
    return new Promise((resolve) => __global.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  };

  // Safe JSON serialization for logs and return values
  function __safeJson(val, seen = new WeakSet()) {
    if (val === undefined) return undefined;
    if (val === null || typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'function') return '[Function]';
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (val instanceof Uint8Array) {
      return '<Uint8Array:' + val.length + 'B>';
    }
    if (typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      if (Array.isArray(val)) return val.map((v) => __safeJson(v, seen));
      const out = {};
      for (const k of Object.keys(val)) {
        out[k] = __safeJson(val[k], seen);
      }
      return out;
    }
    return String(val);
  }

  function __formatArg(v) {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(__safeJson(v));
    } catch {
      return String(v);
    }
  }

  function __makeLogger(level) {
    return function(...args) {
      let stack = '';
      try { throw new Error(''); } catch (e) { stack = String(e.stack || ''); }
      const msg = args.map(__formatArg).join(' ');
      const dataJson = args.length > 1 ? JSON.stringify(__safeJson(args.length === 2 ? args[1] : args.slice(1))) : (args.length === 1 && typeof args[0] === 'object' ? JSON.stringify(__safeJson(args[0])) : '');
      __hostLog(level, msg, dataJson || '', stack);
    };
  }

  __global.console = {
    log: __makeLogger('info'),
    info: __makeLogger('info'),
    warn: __makeLogger('warn'),
    error: __makeLogger('error'),
    debug: __makeLogger('debug'),
  };

  // Base64 & UTF-8 helpers + minimal Buffer/TextEncoder/TextDecoder
  const __b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function __toBytesUtf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }
  function __fromBytesUtf8(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b0 = bytes[i];
      if (b0 < 0x80) { s += String.fromCharCode(b0); }
      else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
        s += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[++i] & 0x3f));
      } else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
        s += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
      } else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
        const cp = ((b0 & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
        const off = cp - 0x10000;
        s += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
      }
    }
    return s;
  }
  function __b64encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const trip = (b0 << 16) | (b1 << 8) | b2;
      out += __b64chars[(trip >> 18) & 63] + __b64chars[(trip >> 12) & 63]
        + (i + 1 < bytes.length ? __b64chars[(trip >> 6) & 63] : '=')
        + (i + 2 < bytes.length ? __b64chars[trip & 63] : '=');
    }
    return out;
  }
  function __b64decode(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = __b64chars.indexOf(clean[i] || 'A');
      const c1 = __b64chars.indexOf(clean[i + 1] || 'A');
      const c2 = clean[i + 2] === '=' ? -1 : __b64chars.indexOf(clean[i + 2] || 'A');
      const c3 = clean[i + 3] === '=' ? -1 : __b64chars.indexOf(clean[i + 3] || 'A');
      out.push((c0 << 2) | (c1 >> 4));
      if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(out);
  }
  __global.btoa = (s) => __b64encode(__toBytesUtf8(String(s)));
  __global.atob = (s) => __fromBytesUtf8(__b64decode(String(s)));
  __global.TextEncoder = class { encode(s = '') { return __toBytesUtf8(String(s)); } };
  __global.TextDecoder = class { decode(b = new Uint8Array()) { return __fromBytesUtf8(b instanceof Uint8Array ? b : new Uint8Array(b)); } };

  class SimBuffer extends Uint8Array {
    static from(input, encoding = 'utf8') {
      if (typeof input === 'string') {
        const bytes = encoding === 'base64' ? __b64decode(input) : __toBytesUtf8(input);
        return new SimBuffer(bytes);
      }
      if (input instanceof Uint8Array || Array.isArray(input)) return new SimBuffer(input);
      if (input instanceof ArrayBuffer) return new SimBuffer(new Uint8Array(input));
      return new SimBuffer(0);
    }
    static alloc(size, fill = 0) {
      const b = new SimBuffer(Math.max(0, Number(size) || 0));
      if (fill !== 0) b.fill(Number(fill) & 0xff);
      return b;
    }
    static isBuffer(v) { return v instanceof SimBuffer || v instanceof Uint8Array; }
    static byteLength(s) { return typeof s === 'string' ? __toBytesUtf8(s).length : (s?.byteLength || 0); }
    static concat(list) {
      const total = list.reduce((acc, b) => acc + b.length, 0);
      const out = new SimBuffer(total);
      let off = 0;
      for (const b of list) { out.set(b, off); off += b.length; }
      return out;
    }
    toString(encoding = 'utf8') {
      return encoding === 'base64' ? __b64encode(this) : __fromBytesUtf8(this);
    }
  }
  __global.Buffer = SimBuffer;

  // Web URL, URLSearchParams, Headers, Request, Response
  class SimURLSearchParams {
    constructor(init = '') {
      this._entries = [];
      if (typeof init === 'string') {
        const clean = init.startsWith('?') ? init.slice(1) : init;
        if (clean) {
          for (const part of clean.split('&')) {
            const eq = part.indexOf('=');
            const k = decodeURIComponent((eq >= 0 ? part.slice(0, eq) : part).replace(/\\+/g, ' '));
            const v = eq >= 0 ? decodeURIComponent(part.slice(eq + 1).replace(/\\+/g, ' ')) : '';
            this._entries.push([k, v]);
          }
        }
      } else if (init && typeof init === 'object') {
        for (const [k, v] of Object.entries(init)) this._entries.push([k, String(v)]);
      }
    }
    get(k) { const found = this._entries.find(([key]) => key === k); return found ? found[1] : null; }
    getAll(k) { return this._entries.filter(([key]) => key === k).map(([, v]) => v); }
    has(k) { return this._entries.some(([key]) => key === k); }
    set(k, v) { this.delete(k); this._entries.push([String(k), String(v)]); }
    append(k, v) { this._entries.push([String(k), String(v)]); }
    delete(k) { this._entries = this._entries.filter(([key]) => key !== k); }
    entries() { return this._entries[Symbol.iterator](); }
    [Symbol.iterator]() { return this._entries[Symbol.iterator](); }
    toString() { return this._entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
  }
  __global.URLSearchParams = SimURLSearchParams;

  class SimURL {
    constructor(raw, base) {
      let full = String(raw);
      if (base && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(full)) {
        const b = String(base).replace(/\\/+$/, '');
        full = b + (full.startsWith('/') ? full : '/' + full);
      }
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\\/\\/([^\\/?#]+)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(full);
      if (!m) throw new TypeError('Invalid URL: ' + raw);
      this.protocol = m[1].toLowerCase() + ':';
      this.host = m[2];
      const colonIdx = this.host.indexOf(':');
      this.hostname = colonIdx >= 0 ? this.host.slice(0, colonIdx) : this.host;
      this.port = colonIdx >= 0 ? this.host.slice(colonIdx + 1) : '';
      this.origin = this.protocol + '//' + this.host;
      this.pathname = m[3] || '/';
      this.search = m[4] || '';
      this.hash = m[5] || '';
      this.searchParams = new SimURLSearchParams(this.search);
      this.href = full;
    }
    toString() { return this.href; }
  }
  __global.URL = SimURL;

  class SimHeaders {
    constructor(init) {
      this._map = {};
      if (init && typeof init === 'object') {
        for (const [k, v] of Object.entries(init)) this._map[k.toLowerCase()] = String(v);
      }
    }
    get(k) { return this._map[String(k).toLowerCase()] ?? null; }
    set(k, v) { this._map[String(k).toLowerCase()] = String(v); }
    has(k) { return String(k).toLowerCase() in this._map; }
    delete(k) { delete this._map[String(k).toLowerCase()]; }
    entries() { return Object.entries(this._map)[Symbol.iterator](); }
    forEach(cb) { for (const [k, v] of Object.entries(this._map)) cb(v, k, this); }
    toJSON() { return { ...this._map }; }
  }
  __global.Headers = SimHeaders;

  class SimRequest {
    constructor(url, init = {}) {
      this.url = String(url);
      this.method = String(init.method || 'GET').toUpperCase();
      this.headers = init.headers instanceof SimHeaders ? init.headers : new SimHeaders(init.headers);
      this._body = init.body === undefined || init.body === null ? '' : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
    }
    async text() { return this._body; }
    async json() { return this._body ? JSON.parse(this._body) : {}; }
  }
  __global.Request = SimRequest;

  class SimResponse {
    constructor(body = '', init = {}) {
      this._body = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
      this.status = Number(init.status ?? 200);
      this.ok = this.status >= 200 && this.status < 300;
      this.statusText = init.statusText || (this.ok ? 'OK' : 'Error');
      this.headers = init.headers instanceof SimHeaders ? init.headers : new SimHeaders(init.headers);
    }
    static json(data, init = {}) {
      const hdrs = new SimHeaders(init.headers);
      if (!hdrs.has('content-type')) hdrs.set('content-type', 'application/json');
      return new SimResponse(JSON.stringify(data), { ...init, headers: hdrs });
    }
    async text() { return this._body; }
    async json() { return this._body ? JSON.parse(this._body) : null; }
  }
  __global.Response = SimResponse;

  // In-memory /tmp VFS (64 MB max) & restricted Node runtime globals
  const __tmpFiles = new Map();
  let __tmpBytesUsed = 0;
  const __MAX_TMP_BYTES = ${maxTmp};
  function __normalizeTmpPath(p) {
    const str = String(p || '');
    if (!str.startsWith('/tmp/') && str !== '/tmp') {
      throw new Error('Filesystem access outside /tmp is not available in the simulator (' + str + ')');
    }
    return str;
  }
  __global.__infrasimFs = {
    writeFileSync(p, data) {
      const norm = __normalizeTmpPath(p);
      const bytes = data instanceof Uint8Array ? new Uint8Array(data) : __toBytesUtf8(String(data));
      const prev = __tmpFiles.get(norm);
      const nextUsed = __tmpBytesUsed - (prev ? prev.length : 0) + bytes.length;
      if (nextUsed > __MAX_TMP_BYTES) {
        throw new Error('In-memory /tmp filesystem limit exceeded (64 MB)');
      }
      __tmpBytesUsed = nextUsed;
      __tmpFiles.set(norm, bytes);
    },
    readFileSync(p, enc) {
      const norm = __normalizeTmpPath(p);
      const bytes = __tmpFiles.get(norm);
      if (!bytes) throw Object.assign(new Error('ENOENT: no such file ' + norm), { code: 'ENOENT' });
      return enc ? __fromBytesUtf8(bytes) : new SimBuffer(bytes);
    },
    existsSync(p) { return p === '/tmp' || __tmpFiles.has(__normalizeTmpPath(p)); },
    unlinkSync(p) {
      const norm = __normalizeTmpPath(p);
      const prev = __tmpFiles.get(norm);
      if (prev) { __tmpBytesUsed -= prev.length; __tmpFiles.delete(norm); }
    },
    mkdirSync(p) { __normalizeTmpPath(p); },
  };
  __global.__infrasimUnsupported = function(name) {
    throw new Error(name + ' is not available in the simulator');
  };

  __global.process = {
    env: ${envJson},
    version: 'v20.0.0-sim',
    platform: 'linux',
    cwd: () => '/tmp',
    exit: () => { throw new Error('process.exit is not available in the simulator'); },
    nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  };

  // Pending mock callbacks & discovery auto-vivifying Proxy
  const __pendingMocks = new Map();
  __global.__infrasimSettleMock = function(callId, ok, payloadJson) {
    const cb = __pendingMocks.get(callId);
    if (!cb) return;
    __pendingMocks.delete(callId);
    let parsed;
    try {
      parsed = payloadJson ? JSON.parse(payloadJson) : undefined;
    } catch {
      parsed = payloadJson;
    }
    if (ok) {
      cb.resolve(parsed);
    } else {
      const errInfo = parsed || { name: 'MockServiceError', message: 'Mock error' };
      const err = new Error(errInfo.message || 'Mock error');
      Object.assign(err, errInfo);
      err.name = errInfo.name || 'MockServiceError';
      cb.reject(err);
    }
  };

  function __makeDiscoveryProxy(serviceId, op, pathParts = []) {
    const target = Object.assign(() => undefined, {
      __isDiscoveryProxy: true,
      toJSON: () => undefined,
    });
    return new Proxy(target, {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) {
          return (hint) => {
            if (pathParts.length > 0) {
              __hostRecordDiscovery(serviceId, op, pathParts.join('.'));
            }
            return hint === 'number' ? 0 : 'sample';
          };
        }
        if (prop === Symbol.iterator) {
          return function* () {
            if (pathParts.length > 0) {
              __hostRecordDiscovery(serviceId, op, pathParts.join('.') + '[0]');
            }
            yield __makeDiscoveryProxy(serviceId, op, [...pathParts, '0']);
          };
        }
        if (prop === 'then' || prop === '__isDiscoveryProxy') {
          return undefined;
        }
        if (prop === 'toString' || prop === 'valueOf') {
          return () => {
            if (pathParts.length > 0) {
              __hostRecordDiscovery(serviceId, op, pathParts.join('.'));
            }
            return 'sample';
          };
        }
        if (prop === 'length') {
          return 1;
        }
        if (prop === 'map' || prop === 'forEach' || prop === 'filter' || prop === 'find' || prop === 'reduce') {
          return (fn) => {
            const elem = __makeDiscoveryProxy(serviceId, op, [...pathParts, '0']);
            if (typeof fn === 'function') {
              const out = fn(elem, 0, [elem]);
              return prop === 'map' ? [out] : prop === 'filter' ? [elem] : prop === 'find' ? elem : undefined;
            }
            return [];
          };
        }
        if (typeof prop === 'symbol') return undefined;
        const nextPath = [...pathParts, String(prop)];
        __hostRecordDiscovery(serviceId, op, nextPath.join('.'));
        return __makeDiscoveryProxy(serviceId, op, nextPath);
      },
      has() { return true; },
    });
  }

  function __invokeMock(req) {
    let siteStack = '';
    try { throw new Error(''); } catch (e) { siteStack = String(e.stack || ''); }
    return new Promise((resolve, reject) => {
      const reqStr = JSON.stringify({ ...req, siteStack });
      const callId = __hostMockCall(reqStr);
      __pendingMocks.set(callId, {
        resolve: (val) => {
          if (__discoveryMode && req.kind === 'cloud') {
            resolve(__makeDiscoveryProxy(req.serviceId, req.op, []));
          } else {
            resolve(val);
          }
        },
        reject,
      });
    });
  }

  __global.cloud = {
    call(serviceId, op, input = {}, opts = {}) {
      return __invokeMock({
        kind: 'cloud',
        sdkStyle: 'universal',
        serviceId: String(serviceId),
        op: String(op),
        input: __safeJson(input),
        region: opts?.region,
        alias: opts?.alias,
      });
    },
    stream(serviceId, op, input = {}, opts = {}) {
      return __global.__infrasimCreateStream({
        kind: 'cloud',
        sdkStyle: 'universal',
        serviceId: String(serviceId),
        op: String(op),
        input: __safeJson(input),
        region: opts?.region,
        alias: opts?.alias,
        stream: true,
      });
    },
  };

  __global.__infrasimCreateStream = function(req) {
    return {
      async *[Symbol.asyncIterator]() {
        const res = await __invokeMock({ ...req, stream: true });
        if (res && Array.isArray(res.__streamChunks)) {
          for (const chunk of res.__streamChunks) {
            if (chunk.delayMs > 0) {
              await __global.sleep(chunk.delayMs);
            }
            yield chunk.data;
          }
        } else {
          yield res;
        }
      },
    };
  };

  __global.fetch = async function(url, init = {}) {
    const res = await __invokeMock({
      kind: 'http',
      sdkStyle: 'http',
      method: String(init?.method || 'GET').toUpperCase(),
      url: String(url),
      headers: init?.headers instanceof SimHeaders ? init.headers.toJSON() : (init?.headers || {}),
      body: __safeJson(init?.body),
    });
    const status = typeof res?.statusCode === 'number' ? res.statusCode : 200;
    const hdrs = new SimHeaders(res?.headers || {});
    const bodyText = typeof res?.body === 'string' ? res.body : JSON.stringify(res?.body ?? res ?? {});
    return new SimResponse(bodyText, { status, headers: hdrs });
  };

  // Expose internal invoke helper for SDK shims bundled into the guest
  __global.__infrasimInvokeSdk = __invokeMock;
  __global.__infrasimSafeJson = __safeJson;
})();
`;
}
