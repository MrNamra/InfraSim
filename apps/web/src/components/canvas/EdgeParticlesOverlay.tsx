'use client';

import { useEffect, useRef } from 'react';
import { ViewportPortal, useStoreApi } from '@xyflow/react';
import type { SimFrame } from '@infrasim/shared-types';
import {
  EDGE_PARTICLE_GLOBAL_CAP,
  advanceEdgeParticleState,
  computeEdgeParticleStatus,
  computeEdgeTargetParticleCount,
  computeEdgeVelocityPxPerSec,
  interpolateLutPoint,
  sampleEdgePathLut,
  type EdgeParticleState,
  type ParticleStatus,
  type SampledEdgePath,
} from './edgeParticles';
import { useCanvasSimState, useEdgePathRegistry } from './CanvasSimContext';

function resolveStatusPalette(): Record<ParticleStatus, string> {
  if (typeof window === 'undefined') {
    return { ok: '#4cc38a', warm: '#e5a00d', error: '#e5484d' };
  }
  const styles = window.getComputedStyle(document.documentElement);
  return {
    ok: styles.getPropertyValue('--status-ok').trim() || '#4cc38a',
    warm: styles.getPropertyValue('--status-warm').trim() || '#e5a00d',
    error: styles.getPropertyValue('--status-overloaded').trim() || '#e5484d',
  };
}

/**
 * Inner canvas renderer mounted only after `<ViewportPortal>` attaches to `.react-flow__viewport-portal`,
 * ensuring `canvasRef.current` is guaranteed non-null when the rAF loop initializes.
 */
function EdgeParticlesCanvas({ theme }: { theme: 'dark' | 'light' }) {
  const registry = useEdgePathRegistry();
  const simState = useCanvasSimState();
  const storeApi = useStoreApi();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particleMapRef = useRef<Map<string, EdgeParticleState>>(new Map());
  const lutCacheRef = useRef<Map<string, SampledEdgePath>>(new Map());
  const paletteRef = useRef<Record<ParticleStatus, string>>(resolveStatusPalette());

  const simStateRef = useRef<{
    currentFrame: SimFrame | null;
    reducedMotion: boolean;
  }>({
    currentFrame: simState?.currentFrame ?? null,
    reducedMotion: Boolean(simState?.reducedMotion),
  });

  useEffect(() => {
    paletteRef.current = resolveStatusPalette();
  }, [theme]);

  // Keep latest simulation frame accessible inside rAF without restarting loop
  const needsLoopRestartRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    simStateRef.current = {
      currentFrame: simState?.currentFrame ?? null,
      reducedMotion: Boolean(simState?.reducedMotion),
    };
    needsLoopRestartRef.current?.();
  }, [simState?.currentFrame, simState?.reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !registry) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();
    let destroyed = false;

    const getLut = (edgeId: string, pathD: string): SampledEdgePath => {
      const cached = lutCacheRef.current.get(edgeId);
      if (cached && cached.pathD === pathD) {
        return cached;
      }
      const next = sampleEdgePathLut(pathD, 48);
      lutCacheRef.current.set(edgeId, next);
      return next;
    };

    const syncCanvasMetricsAndTransform = () => {
      const state = storeApi.getState();
      const [tx, ty, zoom] = state.transform;
      const rfRoot = canvas.closest('.react-flow');
      const width = Math.max(1, Math.round(state.width || rfRoot?.clientWidth || 1));
      const height = Math.max(1, Math.round(state.height || rfRoot?.clientHeight || 1));
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.transform = `scale(${1 / zoom}) translate(${-tx}px, ${-ty}px)`;

      return { tx, ty, zoom, width, height, dpr };
    };

    const drawFrame = (nowTs: number): boolean => {
      const { tx, ty, zoom, width, height, dpr } = syncCanvasMetricsAndTransform();
      const dtSec = Math.min(0.1, Math.max(0, (nowTs - lastTs) / 1000));
      lastTs = nowTs;

      const { currentFrame, reducedMotion } = simStateRef.current;
      const geometries = registry.getEdgeGeometries();

      // Drop stale particle/LUT entries for removed edges
      for (const edgeId of Array.from(particleMapRef.current.keys())) {
        if (!geometries.has(edgeId)) {
          particleMapRef.current.delete(edgeId);
          lutCacheRef.current.delete(edgeId);
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (!currentFrame || geometries.size === 0) {
        canvas.setAttribute('data-active-particles', '0');
        return false;
      }

      let remainingBudget = EDGE_PARTICLE_GLOBAL_CAP;
      let totalActiveDots = 0;
      const dotRadius = Math.max(2.1, Math.min(3.5, 2.5 * Math.sqrt(zoom)));
      const colors = paletteRef.current;

      for (const [edgeId, geom] of geometries.entries()) {
        const edgeFrame = currentFrame.edges[edgeId];
        const rps = edgeFrame?.rps ?? 0;
        const desiredCount = computeEdgeTargetParticleCount(rps, geom.blocked, reducedMotion);
        const allocatedCount = Math.min(remainingBudget, desiredCount);
        remainingBudget -= allocatedCount;

        if (allocatedCount <= 0) {
          particleMapRef.current.delete(edgeId);
          continue;
        }

        const lut = getLut(edgeId, geom.pathD);
        if (lut.length <= 0) {
          continue;
        }

        const status = computeEdgeParticleStatus(
          edgeFrame?.errorRate ?? 0,
          edgeFrame?.avgLatencyMs ?? 0,
        );

        let offsets: number[];
        if (reducedMotion) {
          offsets = [0.5];
        } else {
          const velocityPxPerSec = computeEdgeVelocityPxPerSec(rps);
          const targetCyclesPerSec = velocityPxPerSec / Math.max(72, lut.length);
          const prev = particleMapRef.current.get(edgeId);
          const next = advanceEdgeParticleState(prev, {
            targetCount: allocatedCount,
            targetCyclesPerSec,
            status,
            dtSec,
          });
          particleMapRef.current.set(edgeId, next);
          offsets = next.offsets;
        }

        ctx.fillStyle = colors[status];
        for (const t of offsets) {
          const pt = interpolateLutPoint(lut, t);
          const sx = pt.x * zoom + tx;
          const sy = pt.y * zoom + ty;
          if (sx < -8 || sy < -8 || sx > width + 8 || sy > height + 8) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fill();
          totalActiveDots++;
        }
      }

      canvas.setAttribute('data-active-particles', String(totalActiveDots));
      return !reducedMotion && totalActiveDots > 0;
    };

    const scheduleTick = () => {
      if (destroyed || rafId !== 0) {
        return;
      }
      lastTs = performance.now();
      rafId = window.requestAnimationFrame(loop);
    };

    const loop = (nowTs: number) => {
      rafId = 0;
      if (destroyed) {
        return;
      }
      const keepGoing = drawFrame(nowTs);
      if (keepGoing) {
        rafId = window.requestAnimationFrame(loop);
      }
    };

    needsLoopRestartRef.current = () => {
      if (destroyed) {
        return;
      }
      if (simStateRef.current.reducedMotion || !simStateRef.current.currentFrame) {
        if (rafId !== 0) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        drawFrame(performance.now());
      } else {
        const keepGoing = drawFrame(performance.now());
        if (keepGoing && rafId === 0) {
          scheduleTick();
        }
      }
    };

    // Synchronize immediately on pan/zoom/viewport resize without waiting a React render
    const unsubStore = storeApi.subscribe((next, prev) => {
      if (
        next.transform[0] !== prev.transform[0] ||
        next.transform[1] !== prev.transform[1] ||
        next.transform[2] !== prev.transform[2] ||
        next.width !== prev.width ||
        next.height !== prev.height
      ) {
        if (rafId === 0) {
          drawFrame(performance.now());
        } else {
          syncCanvasMetricsAndTransform();
        }
      }
    });

    // Redraw immediately when edge curves change due to node dragging or new edge mounts
    const unsubGeom = registry.subscribeGeometry(() => {
      if (rafId === 0) {
        needsLoopRestartRef.current?.();
      }
    });

    needsLoopRestartRef.current();

    return () => {
      destroyed = true;
      needsLoopRestartRef.current = null;
      unsubGeom();
      unsubStore();
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [registry, storeApi]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="edge-particles-canvas"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0"
      style={{ transformOrigin: '0 0' }}
    />
  );
}

/**
 * Single high-DPI `<canvas>` overlay animating request dots along edge curves via `requestAnimationFrame`
 * without SMIL `<animateMotion>` resets or React node/edge re-renders.
 */
export function EdgeParticlesOverlay({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <ViewportPortal>
      <EdgeParticlesCanvas theme={theme} />
    </ViewportPortal>
  );
}
