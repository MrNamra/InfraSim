/** Lightweight API client for Laravel Sanctum authentication, custom services, and backend sync. */

import type { PriceSnapshot } from '@infrasim/cost-engine';
import type {
  CallPlan,
  Challenge,
  ChallengeAttemptResult,
  CustomServiceDefinition,
  Design,
  FixtureTemplateId,
  PayloadFixture,
} from '@infrasim/shared-types';

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

export interface FixtureApiRecord {
  id: string;
  name: string;
  template?: FixtureTemplateId;
  event: unknown;
  schema?: Record<string, unknown>;
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

/** List saved payload fixtures in the authenticated user's library. */
export async function fetchFixturesApi(token: string): Promise<FixtureApiRecord[]> {
  const res = await apiRequest<{ fixtures: FixtureApiRecord[] }>('/api/fixtures', { token });
  return res.fixtures;
}

/** Save a payload fixture to the authenticated user's library. */
export async function createFixtureApi(
  token: string,
  fixture: Omit<PayloadFixture, 'id'>,
): Promise<FixtureApiRecord> {
  const res = await apiRequest<{ fixture: FixtureApiRecord }>('/api/fixtures', {
    method: 'POST',
    token,
    body: JSON.stringify({
      name: fixture.name,
      template: fixture.template ?? null,
      event: fixture.event,
      schema: fixture.schema ?? null,
    }),
  });
  return res.fixture;
}

/** Update an existing saved payload fixture in the user's library. */
export async function updateFixtureApi(
  token: string,
  id: string,
  fixture: Omit<PayloadFixture, 'id'>,
): Promise<FixtureApiRecord> {
  const res = await apiRequest<{ fixture: FixtureApiRecord }>(
    `/api/fixtures/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      token,
      body: JSON.stringify({
        name: fixture.name,
        template: fixture.template ?? null,
        event: fixture.event,
        schema: fixture.schema ?? null,
      }),
    },
  );
  return res.fixture;
}

/** Delete a saved payload fixture from the user's library. */
export async function deleteFixtureApi(token: string, id: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(`/api/fixtures/${encodeURIComponent(id)}`, {
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

export interface ChallengeProgressSummary {
  attempts: number;
  bestScore: number | null;
  passed: boolean;
}

export interface ChallengeApiRecord {
  slug: string;
  title: string;
  difficulty: Challenge['difficulty'];
  definition: Challenge;
  myProgress: ChallengeProgressSummary | null;
}

export interface ChallengeAttemptApiResponse {
  attempt: {
    id: number;
    score: number;
    passed: boolean;
    seed: number;
    createdAt?: string;
  };
  result: ChallengeAttemptResult;
  attemptsCount: number;
  referenceSolutionDesign?: Design;
  whatThisTeaches?: string;
}

export interface ChallengeLeaderboardEntry {
  displayName: string;
  score: number;
  monthlyCostUsd: number | null;
  p95Ms: number | null;
  createdAt?: string;
}

/** List published architectural challenges with optional signed-in user progress. */
export async function fetchChallengesApi(token?: string | null): Promise<ChallengeApiRecord[]> {
  const res = await apiRequest<{ challenges: ChallengeApiRecord[] }>('/api/challenges', { token });
  return res.challenges;
}

/** Submit a design attempt for deterministic server-side Node evaluation. */
export async function submitChallengeAttemptApi(
  token: string,
  slug: string,
  design: Design,
  callPlans?: Record<string, CallPlan>,
): Promise<ChallengeAttemptApiResponse> {
  return apiRequest<ChallengeAttemptApiResponse>(
    `/api/challenges/${encodeURIComponent(slug)}/attempts`,
    {
      method: 'POST',
      token,
      body: JSON.stringify({
        design,
        ...(callPlans && Object.keys(callPlans).length > 0 ? { callPlans } : {}),
      }),
    },
  );
}

/** Reveal the hidden reference solution design for a challenge after user confirmation. */
export async function revealChallengeSolutionApi(
  token: string,
  slug: string,
): Promise<{ referenceSolutionDesign: Design; whatThisTeaches: string }> {
  return apiRequest<{ referenceSolutionDesign: Design; whatThisTeaches: string }>(
    `/api/challenges/${encodeURIComponent(slug)}/reveal`,
    {
      method: 'POST',
      token,
    },
  );
}

/** Fetch public challenge leaderboard ordered by score or monthly cost. */
export async function fetchChallengeLeaderboardApi(
  slug: string,
  sort: 'score' | 'cost' = 'score',
): Promise<ChallengeLeaderboardEntry[]> {
  const res = await apiRequest<{ entries: ChallengeLeaderboardEntry[] }>(
    `/api/challenges/${encodeURIComponent(slug)}/leaderboard?sort=${sort}`,
  );
  return res.entries;
}
