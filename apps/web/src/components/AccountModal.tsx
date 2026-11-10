'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@infrasim/ui-kit';
import { loginAccount, logoutAccount, registerAccount, type AuthUser } from '../lib/api';

export interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  user: AuthUser | null;
  token: string | null;
  onAuthChange: (user: AuthUser | null, token: string | null) => void;
}

/** Authentication modal supporting Sanctum register, login, logout, and guest mode. */
export function AccountModal({ open, onClose, user, token, onAuthChange }: AccountModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res =
        mode === 'register'
          ? await registerAccount({ name, email, password })
          : await loginAccount({ email, password });
      onAuthChange(res.user, res.token);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setSubmitting(true);
    try {
      await logoutAccount(token);
      onAuthChange(null, null);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        data-testid="account-modal"
        className="w-full max-w-md rounded-[14px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-floating)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-medium text-[var(--text-primary)]">
            {user ? 'Account' : mode === 'login' ? 'Sign in to InfraSim' : 'Create an account'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account modal"
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        {user ? (
          <div className="space-y-4">
            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] p-4">
              <div className="text-[14px] font-medium text-[var(--text-primary)]">{user.name}</div>
              <div className="mt-1 text-[13px] text-[var(--text-secondary)]">{user.email}</div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={handleLogout} disabled={submitting}>
                Sign out
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex gap-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-1">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`h-8 flex-1 rounded-[6px] text-[13px] font-medium transition-colors ${
                  mode === 'login'
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
                className={`h-8 flex-1 rounded-[6px] text-[13px] font-medium transition-colors ${
                  mode === 'register'
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Register
              </button>
            </div>

            {mode === 'register' ? (
              <div>
                <label className="mb-1.5 block text-[12px] text-[var(--text-secondary)]">
                  Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="h-9 w-full rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            ) : null}

            <div>
              <label className="mb-1.5 block text-[12px] text-[var(--text-secondary)]">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
                className="h-9 w-full rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-[var(--text-secondary)]">
                Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="h-9 w-full rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            {error ? (
              <p className="rounded-[8px] border border-[var(--status-overloaded)]/30 bg-[var(--status-overloaded)]/10 px-3 py-2 text-[12px] text-[var(--status-overloaded)]">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-between pt-1">
              <span className="text-[12px] text-[var(--text-muted)]">
                Local designs save automatically without an account
              </span>
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? 'Working' : mode === 'login' ? 'Sign in' : 'Create account'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
