/** Pure IPv4 and CIDR arithmetic helpers (32-bit unsigned integer bit ops). */

export interface ParsedCidr {
  cidr: string;
  networkInt: number;
  maskInt: number;
  broadcastInt: number;
  prefix: number;
}

/** Validates a dotted-quad IPv4 address string. */
export function isValidIpv4(ip: string): boolean {
  return ipToInt(ip) !== null;
}

/** Converts a dotted-quad IPv4 string to an unsigned 32-bit integer, or null if invalid. */
export function ipToInt(ip: string): number | null {
  const trimmed = ip.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const seg = parts[i]!;
    if (!/^\d{1,3}$/.test(seg)) {
      return null;
    }
    const val = Number(seg);
    if (!Number.isInteger(val) || val < 0 || val > 255) {
      return null;
    }
    acc = ((acc << 8) | val) >>> 0;
  }
  return acc >>> 0;
}

/** Formats an unsigned 32-bit integer as dotted-quad IPv4. */
export function intToIp(num: number): string {
  const n = num >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** Parses an IPv4 CIDR string (e.g. `10.0.1.0/24`) into network/mask/broadcast integers. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const trimmed = cidr.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx <= 0) {
    return null;
  }
  const ipPart = trimmed.slice(0, slashIdx);
  const prefixPart = trimmed.slice(slashIdx + 1);
  if (!/^\d{1,2}$/.test(prefixPart)) {
    return null;
  }
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }
  const baseInt = ipToInt(ipPart);
  if (baseInt === null) {
    return null;
  }
  const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const networkInt = (baseInt & maskInt) >>> 0;
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  return {
    cidr: `${intToIp(networkInt)}/${prefix}`,
    networkInt,
    maskInt,
    broadcastInt,
    prefix,
  };
}

/** Returns true if `ip` falls inside `cidr`. */
export function cidrContainsIp(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  const ipNum = ipToInt(ip);
  if (!parsed || ipNum === null) {
    return false;
  }
  if (parsed.prefix === 0) {
    return true;
  }
  return (ipNum & parsed.maskInt) >>> 0 === parsed.networkInt;
}

/** Returns true if CIDR blocks `a` and `b` share any overlapping IP addresses. */
export function cidrsOverlap(a: string, b: string): boolean {
  const pa = parseCidr(a);
  const pb = parseCidr(b);
  if (!pa || !pb) {
    return false;
  }
  return pa.networkInt <= pb.broadcastInt && pb.networkInt <= pa.broadcastInt;
}

/** Returns the prefix length (0–32) for longest-prefix route matching, or -1 if invalid. */
export function prefixLength(cidr: string): number {
  const parsed = parseCidr(cidr);
  return parsed ? parsed.prefix : -1;
}

/** Returns true if an IPv4 address belongs to RFC 1918, CGNAT 100.64/10, or link-local ranges. */
export function isPrivateIp(ip: string): boolean {
  return (
    cidrContainsIp('10.0.0.0/8', ip) ||
    cidrContainsIp('172.16.0.0/12', ip) ||
    cidrContainsIp('192.168.0.0/16', ip) ||
    cidrContainsIp('100.64.0.0/10', ip) ||
    cidrContainsIp('169.254.0.0/16', ip) ||
    cidrContainsIp('127.0.0.0/8', ip)
  );
}

/** Returns true if an IPv4 address is a routable public address. */
export function isPublicIp(ip: string): boolean {
  return isValidIpv4(ip) && !isPrivateIp(ip);
}

/** Allocates the next deterministic host IP within `cidr` not present in `usedIps`. */
export function allocateIpFromCidr(
  cidr: string,
  usedIps: ReadonlySet<string>,
  offsetStart = 10,
): string {
  const parsed = parseCidr(cidr);
  if (!parsed) {
    return '10.0.0.10';
  }
  const size = Math.max(1, parsed.broadcastInt - parsed.networkInt + 1);
  const firstCandidate = Math.min(size - 2, Math.max(4, offsetStart));
  for (let offset = firstCandidate; offset < size - 1 && offset < firstCandidate + 4096; offset++) {
    const candidate = intToIp((parsed.networkInt + offset) >>> 0);
    if (!usedIps.has(candidate)) {
      return candidate;
    }
  }
  return intToIp((parsed.networkInt + 4) >>> 0);
}

/** Allocates a non-overlapping `/24` subnet CIDR inside a parent VPC CIDR. */
export function allocateSubnetCidr(
  vpcCidr: string,
  existingSubnetCidrs: readonly string[],
): string {
  const parsed = parseCidr(vpcCidr);
  if (!parsed || parsed.prefix > 24) {
    return '10.0.1.0/24';
  }
  const thirdStart = ((parsed.networkInt >>> 8) & 0xff) + 1;
  const baseTop = (parsed.networkInt & 0xffff0000) >>> 0;
  for (let i = thirdStart; i < 254; i++) {
    const candidate = intToIp((baseTop | (i << 8)) >>> 0) + '/24';
    if (
      cidrContainsIp(vpcCidr, intToIp((baseTop | (i << 8)) >>> 0)) &&
      !existingSubnetCidrs.some((c) => cidrsOverlap(c, candidate))
    ) {
      return candidate;
    }
  }
  return '10.0.1.0/24';
}
