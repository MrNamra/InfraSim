import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Cpu, Database, EyeOff, Lock, Shield } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Privacy Policy — InfraSim',
  description:
    'InfraSim privacy principles, local-first architecture commitments, and data guarantees.',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] antialiased">
      <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
            Back to Workbench
          </Link>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-[var(--accent)]" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              Privacy Architecture
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-10">
          <div className="flex items-center gap-2.5 text-[var(--accent)]">
            <Shield className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[13px] font-medium uppercase tracking-wider">
              Local-first & Sandboxed
            </span>
          </div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-[var(--text-primary)]">
            Privacy Policy & Data Guarantees
          </h1>
          <p className="mt-2 text-[14px] text-[var(--text-secondary)]">
            Effective Date: November 13, 2026 · InfraSim Workbench
          </p>
        </div>

        <section className="mb-8 rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-6 shadow-sm">
          <h2 className="text-[16px] font-medium text-[var(--text-primary)]">
            Our Core Privacy Principle
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            InfraSim is built as a deterministic, client-side cloud architecture workbench. You do
            not need to trust our servers with your proprietary infrastructure layouts or
            application code because simulation, diagnosis, and layout computation occur entirely
            within your browser.
          </p>
        </section>

        <div className="space-y-6 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-medium">
              <Database className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
              <h3 className="text-[14px]">1. Local-first storage by default</h3>
            </div>
            <p className="mt-2">
              All architecture canvases, custom service schemas, test scenarios, and simulated run
              frames are stored locally in your browser using IndexedDB. You can build, simulate,
              and export full topologies completely offline without logging in or transmitting data
              over the network.
            </p>
          </div>

          <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-medium">
              <Cpu className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
              <h3 className="text-[14px]">2. Browser-isolated WebAssembly sandbox</h3>
            </div>
            <p className="mt-2">
              User-authored TypeScript and JavaScript handler scripts execute inside a sandboxed
              QuickJS engine compiled to WebAssembly within a dedicated Web Worker. The sandbox is
              completely isolated: it has no network socket access, no filesystem access, and
              enforces strict memory (≤ 128 MB) and execution timeouts (≤ 500 ms). We never send,
              run, or log your handler code on remote servers.
            </p>
          </div>

          <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-medium">
              <Lock className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
              <h3 className="text-[14px]">3. Optional cloud synchronization & sharing</h3>
            </div>
            <p className="mt-2">
              If you optionally create an account to synchronize designs across devices or generate
              read-only share links, designs are transmitted over TLS 1.3 to our API. Shared links
              use cryptographically random 32-character tokens, and unlisted links can be revoked at
              any moment with one click.
            </p>
          </div>

          <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-medium">
              <EyeOff className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
              <h3 className="text-[14px]">
                4. Zero telemetry on proprietary designs & zero trackers
              </h3>
            </div>
            <p className="mt-2">
              InfraSim contains zero third-party advertising trackers, zero cookie profiling
              networks, and zero analytics scripts. Server logs record only standard operational
              metrics (request method, status, response latency, and request ID) without storing
              design documents, credentials, or environment secrets.
            </p>
          </div>
        </div>

        <footer className="mt-12 border-t border-[var(--border-hairline)] pt-6 text-[12px] text-[var(--text-muted)]">
          <p>
            Questions or data deletion requests? Contact privacy@infrasim.dev or review our
            open-source architecture at{' '}
            <a
              href="https://github.com/MrNamra/InfraSim"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
            >
              github.com/MrNamra/InfraSim
            </a>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
