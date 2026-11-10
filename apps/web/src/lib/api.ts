/** Lightweight API client for Laravel Sanctum authentication, custom services, and backend sync. */

import type { PriceSnapshot } from '@infrasim/cost-engine';
import type { CustomServiceDefinition } from '@infrasim/shared-types';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

export interface CustomServiceApiRecord {
  id: string;
  serviceId: string;
  definition: CustomServiceDefinition;
  updatedAt?: string;
}

const TOKEN_STORAGE_KEY = 'infrasim.authToken';

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
}

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function apiRequest<T>(
  path: string,
  options: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const { token, headers, ...rest } = options;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...rest,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const firstFieldErrors =
      data.errors && typeof data.errors === 'object'
        ? Object.values(data.errors as Record<string, unknown[]>)[0]
        : undefined;
    const message =
      (Array.isArray(firstFieldErrors) && typeof firstFieldErrors[0] === 'string'
        ? firstFieldErrors[0]
        : undefined) ??
      (typeof data.message === 'string' ? data.message : `Request failed (${response.status})`);
    throw new Error(message);
  }

  return data as T;
}

/** Register a new account and return user + Sanctum token. */
export async function registerAccount(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await apiRequest<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setStoredToken(res.token);
  return res;
}

/** Sign in with email and password and store Sanctum token. */
export async function loginAccount(input: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await apiRequest<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setStoredToken(res.token);
  return res;
}

/** Fetch current authenticated user using stored token. */
export async function fetchCurrentUser(token: string): Promise<AuthUser> {
  const res = await apiRequest<{ user: AuthUser }>('/api/auth/me', { token });
  return res.user;
}

/** Revoke current Sanctum token and clear local storage. */
export async function logoutAccount(token: string | null): Promise<void> {
  try {
    if (token) {
      await apiRequest('/api/auth/logout', { method: 'POST', token });
    }
  } finally {
    setStoredToken(null);
  }
}

/** List custom services belonging to the authenticated user. */
export async function fetchCustomServicesApi(token: string): Promise<CustomServiceApiRecord[]> {
  const res = await apiRequest<{ customServices: CustomServiceApiRecord[] }>(
    '/api/custom-services',
    {
      token,
    },
  );
  return res.customServices;
}

/** Create a custom service on the backend for the authenticated user. */
export async function createCustomServiceApi(
  token: string,
  definition: CustomServiceDefinition,
): Promise<CustomServiceApiRecord> {
  const res = await apiRequest<{ customService: CustomServiceApiRecord }>('/api/custom-services', {
    method: 'POST',
    token,
    body: JSON.stringify({ definition }),
  });
  return res.customService;
}

/** Update an existing custom service by record UUID or custom.* serviceId. */
export async function updateCustomServiceApi(
  token: string,
  identifier: string,
  definition: CustomServiceDefinition,
): Promise<CustomServiceApiRecord> {
  const res = await apiRequest<{ customService: CustomServiceApiRecord }>(
    `/api/custom-services/${encodeURIComponent(identifier)}`,
    {
      method: 'PUT',
      token,
      body: JSON.stringify({ definition }),
    },
  );
  return res.customService;
}

/** Delete an existing custom service by record UUID or custom.* serviceId. */
export async function deleteCustomServiceApi(token: string, identifier: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(`/api/custom-services/${encodeURIComponent(identifier)}`, {
    method: 'DELETE',
    token,
  });
}

export type FetchPriceSnapshotResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; snapshot: PriceSnapshot; etag: string | null };

/** Fetch compact normalized pricing snapshot from Laravel for the selected providers and regions. */
export async function fetchPriceSnapshotApi(
  providers: readonly string[],
  regions: readonly string[],
  etag?: string | null,
): Promise<FetchPriceSnapshotResult> {
  const params = new URLSearchParams();
  if (providers.length > 0) {
    params.set('providers', providers.join(','));
  }
  if (regions.length > 0) {
    params.set('regions', regions.join(','));
  }
  const qs = params.toString();
  const url = `${getApiBaseUrl()}/api/prices/snapshot${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
  });

  const nextEtag = response.headers.get('ETag');
  if (response.status === 304) {
    return { notModified: true, etag: nextEtag ?? etag ?? null };
  }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof data.message === 'string'
        ? data.message
        : `Price snapshot request failed (${response.status})`;
    throw new Error(message);
  }

  return {
    notModified: false,
    snapshot: data as unknown as PriceSnapshot,
    etag: nextEtag,
  };
}
