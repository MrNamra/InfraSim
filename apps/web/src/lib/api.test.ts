import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomServiceApi,
  deleteCustomServiceApi,
  fetchCurrentUser,
  fetchCustomServicesApi,
  getApiBaseUrl,
  getStoredToken,
  loginAccount,
  logoutAccount,
  registerAccount,
  setStoredToken,
  updateCustomServiceApi,
} from './api';
import { buildCustomServiceDefinition, createCustomServiceDraft } from './customServices';

describe('api client', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    vi.restoreAllMocks();
  });

  function installMockStorage(): Map<string, string> {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => {
          store.set(key, val);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
    return store;
  }

  it('defaults API base URL to http://localhost:8000', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8000');
  });

  it('registers, signs in, fetches user, and clears token on logout', async () => {
    const storage = installMockStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: 1, name: 'Ada', email: 'ada@example.com' },
            token: 'tok-register',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: 1, name: 'Ada', email: 'ada@example.com' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: 1, name: 'Ada', email: 'ada@example.com' },
            token: 'tok-login',
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const reg = await registerAccount({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });
    expect(reg.token).toBe('tok-register');
    expect(getStoredToken()).toBe('tok-register');

    const me = await fetchCurrentUser('tok-register');
    expect(me.email).toBe('ada@example.com');

    await logoutAccount('tok-register');
    expect(getStoredToken()).toBeNull();
    expect(storage.size).toBe(0);

    const login = await loginAccount({ email: 'ada@example.com', password: 'password123' });
    expect(login.token).toBe('tok-login');
    expect(getStoredToken()).toBe('tok-login');

    setStoredToken(null);
    expect(getStoredToken()).toBeNull();
  });

  it('surfaces first Laravel validation error cleanly', async () => {
    installMockStorage();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: 'Validation error',
          errors: { email: ['The email has already been taken.'] },
        }),
        { status: 422 },
      ),
    ) as typeof fetch;

    await expect(
      registerAccount({ name: 'Ada', email: 'ada@example.com', password: 'password123' }),
    ).rejects.toThrow('The email has already been taken.');
  });

  it('lists, creates, updates, and deletes custom services with bearer token', async () => {
    installMockStorage();
    const def = buildCustomServiceDefinition(createCustomServiceDraft());
    const apiRecord = {
      id: '11111111-1111-1111-1111-111111111111',
      serviceId: def.id,
      definition: def,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ customServices: [apiRecord] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ customService: apiRecord }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ customService: apiRecord }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const list = await fetchCustomServicesApi('tok');
    expect(list).toHaveLength(1);
    expect(list[0]?.serviceId).toBe(def.id);

    const created = await createCustomServiceApi('tok', def);
    expect(created.id).toBe(apiRecord.id);

    const updated = await updateCustomServiceApi('tok', def.id, def);
    expect(updated.serviceId).toBe(def.id);

    await deleteCustomServiceApi('tok', def.id);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
