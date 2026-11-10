'use client';

import { createContext, useContext } from 'react';
import type { SimFrame } from '@infrasim/shared-types';

export interface EdgeGeometryEntry {
  edgeId: string;
  pathD: string;
  blocked: boolean;
}

export interface EdgePathRegistryValue {
  registerEdgePath: (edgeId: string, pathD: string, blocked: boolean) => void;
  unregisterEdgePath: (edgeId: string) => void;
  getEdgeGeometries: () => ReadonlyMap<string, EdgeGeometryEntry>;
  subscribeGeometry: (listener: () => void) => () => void;
}

export interface CanvasSimStateValue {
  currentFrame: SimFrame | null;
  nodeReasons: Record<string, string>;
  shakingAllowedIds: ReadonlySet<string>;
  reducedMotion: boolean;
}

export const EdgePathRegistryContext = createContext<EdgePathRegistryValue | null>(null);
export const CanvasSimStateContext = createContext<CanvasSimStateValue | null>(null);

/** Reads stable edge path registry callbacks inside custom edge components. */
export function useEdgePathRegistry(): EdgePathRegistryValue | null {
  return useContext(EdgePathRegistryContext);
}

/** Reads active frame overlay, overload reasons, shake cap, and motion flags inside nodes/edges. */
export function useCanvasSimState(): CanvasSimStateValue | null {
  return useContext(CanvasSimStateContext);
}
