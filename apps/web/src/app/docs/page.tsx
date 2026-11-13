import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock,
  Cpu,
  HelpCircle,
  Layers,
  Network,
  Scale,
  Zap,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Documentation — InfraSim Workbench',
  description:
    'Comprehensive guide to InfraSim: discrete-event simulation mechanics, estimated vs real benchmarks, and architecture glossary.',
};

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] antialiased">
      {/* Top Bar */}
      <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
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
              Architecture Guide
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Hero Title */}
        <div className="mb-12 border-b border-[var(--border-hairline)] pb-8">
          <div className="flex items-center gap-2 text-[var(--accent)]">
            <BookOpen className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[13px] font-medium uppercase tracking-wider">
              Engineering Manual
            </span>
          </div>
          <h1 className="mt-2 text-[32px] font-semibold tracking-tight text-[var(--text-primary)]">
            How InfraSim Works
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            A guide to deterministic discrete-event simulation, what is modeled versus estimated,
            and systems architecture fundamentals.
          </p>
        </div>

        {/* Section 1: How the Simulator Works */}
        <section id="simulator-mechanics" className="mb-14">
          <div className="flex items-center gap-2.5 text-[var(--text-primary)]">
            <Cpu className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.5} />
            <h2 className="text-[20px] font-semibold">1. How the Simulator Works</h2>
          </div>
          <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--text-secondary)]">
            InfraSim runs an in-browser, discrete-event simulation (DES) engine inside a dedicated
            Web Worker pool. Rather than sending requests over the real internet, the simulator
            advances a virtual time clock in microseconds, queueing and routing synthetic request
            events through your visual topology graph.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                <Zap className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
                Traffic Ingestion
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Traffic generators produce requests according to your selected curve (constant,
                ramp, spike, steps, diurnal, or custom trace). Each request tracks payload bytes,
                user flow steps, and client timeouts.
              </p>
            </div>

            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                <Layers className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
                Queues & Concurrency
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Nodes enforce instance limits, thread pool capacities, and FIFO queue buffers. If
                concurrency is saturated, incoming requests wait in queue or trigger immediate 429
                rejections when queues fill.
              </p>
            </div>

            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                <Network className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
                Topology Routing
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Edges model network delays based on VPC boundaries, cross-AZ hops, or public
                internet latency. Egress checks verify firewall rules, route tables, and NAT
                gateways.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2: What's Estimated vs Real */}
        <section id="estimated-vs-real" className="mb-14">
          <div className="flex items-center gap-2.5 text-[var(--text-primary)]">
            <Scale className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.5} />
            <h2 className="text-[20px] font-semibold">
              2. What&apos;s Estimated vs What&apos;s Real
            </h2>
          </div>
          <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--text-secondary)]">
            InfraSim is designed to teach architecture tradeoffs and catch scaling bugs before
            production. Understanding the boundary between exact real execution and statistical
            estimation is essential.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--status-ok)]">
                <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
                What is Real (Deterministic)
              </div>
              <ul className="mt-3 space-y-2 text-[12px] text-[var(--text-secondary)]">
                <li>
                  • <strong>User Code Execution:</strong> JavaScript and TypeScript handler code
                  actually runs in a QuickJS WebAssembly engine.
                </li>
                <li>
                  • <strong>Network Reachability:</strong> Exact hop-by-hop packet evaluation
                  against security groups, NACLs, route tables, and CIDRs.
                </li>
                <li>
                  • <strong>Terraform Compilation:</strong> HCL generation and parser import produce
                  real, valid syntax and dependency graphs.
                </li>
                <li>
                  • <strong>Schema Validation:</strong> Designs and JSON payloads validate strictly
                  against Ajv schemas.
                </li>
                <li>
                  • <strong>Reproducibility:</strong> Random seeds produce identical request traces,
                  latencies, and drops down to the millisecond.
                </li>
              </ul>
            </div>

            <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--accent)]">
                <Clock className="h-4 w-4" strokeWidth={1.5} />
                What is Estimated (Typical Defaults)
              </div>
              <ul className="mt-3 space-y-2 text-[12px] text-[var(--text-secondary)]">
                <li>
                  • <strong>Latency Distributions:</strong> Service p50/p95 times are log-normal
                  distributions labeled &ldquo;Typical default — edit me&rdquo;.
                </li>
                <li>
                  • <strong>Cold Starts:</strong> FaaS cold start penalties (100–1200 ms) reflect
                  observed averages, not cloud provider SLAs.
                </li>
                <li>
                  • <strong>Cost Calculations:</strong> Monthly costs use public on-demand list
                  pricing and do not account for custom enterprise discounts.
                </li>
                <li>
                  • <strong>Hardware Jitter:</strong> Real-world multi-tenant noisy neighbor CPU
                  throttling is simulated statistically via chaos events.
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Section 3: Architecture Glossary */}
        <section id="glossary" className="mb-14">
          <div className="flex items-center gap-2.5 text-[var(--text-primary)]">
            <HelpCircle className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.5} />
            <h2 className="text-[20px] font-semibold">3. Architecture & Systems Glossary</h2>
          </div>
          <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--text-secondary)]">
            Core terminology used throughout the workbench telemetry dock, inspector panels, and
            Why? diagnostics.
          </p>

          <div className="mt-6 divide-y divide-[var(--border-hairline)] rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">
                p50, p95, p99 Latency Percentiles
              </dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                The response time threshold under which 50%, 95%, or 99% of requests complete. While
                p50 represents typical experience, p95 and p99 reveal long-tail delays caused by
                queuing, garbage collection, cold starts, and lock contention.
              </dd>
            </div>

            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">
                Queue Saturation & Little&apos;s Law
              </dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Little&apos;s Law establishes that average concurrent requests in flight (L) equals
                arrival rate (&lambda;) multiplied by average latency (W):{' '}
                <em>L = &lambda; &times; W</em>. When downstream latency climbs, in-flight requests
                accumulate rapidly until queue limits are exhausted.
              </dd>
            </div>

            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">
                Retry Storm & Cascading Failure
              </dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                When a downstream service slows down, upstream callers experience timeouts and
                trigger immediate retries. These duplicate requests multiply arrival rates (2x–4x),
                driving the struggling dependency into total collapse.
              </dd>
            </div>

            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">
                Circuit Breaker Pattern
              </dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                A protective pattern wrapping inter-service calls. When consecutive error rates
                exceed a threshold, the circuit trips from Closed to Open, immediately rejecting
                subsequent requests without burdening the failing backend and giving it room to
                recover.
              </dd>
            </div>

            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">
                Dead-Letter Queue (DLQ)
              </dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                A secondary queue where messages that fail repeatedly (exceeding maximum receive
                count or timeout) are isolated, preventing unprocessable poison pills from blocking
                the primary worker pipeline.
              </dd>
            </div>

            <div className="p-4">
              <dt className="text-[13px] font-medium text-[var(--text-primary)]">Blast Radius</dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                The maximum extent of user disruption caused by the failure of a single component,
                availability zone, or region. Dual-AZ deployments with health checks confine blast
                radius to single-zone degraded capacity.
              </dd>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-[var(--border-hairline)] pt-6 text-[12px] text-[var(--text-muted)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p>© 2026 InfraSim contributors. Released under MIT license.</p>
            <div className="flex gap-4">
              <Link href="/privacy" className="hover:text-[var(--text-primary)]">
                Privacy Policy
              </Link>
              <a
                href="https://github.com/MrNamra/InfraSim"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--text-primary)]"
              >
                GitHub Repository
              </a>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}
