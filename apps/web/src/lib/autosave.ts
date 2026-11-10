import Dexie, { type EntityTable } from 'dexie';
import type { CustomPreset, CustomServiceDefinition, Design } from '@infrasim/shared-types';

export interface StoredDesignRecord {
  id: string;
  name: string;
  updatedAt: number;
  doc: Design;
}

export interface StoredPresetRecord {
  id: string;
  name: string;
  updatedAt: number;
  preset: CustomPreset;
}

export interface StoredCustomServiceRecord {
  id: string;
  name: string;
  updatedAt: number;
  service: CustomServiceDefinition;
}

export interface StoredMetaRecord {
  key: string;
  value: string;
}

class InfraSimDatabase extends Dexie {
  designs!: EntityTable<StoredDesignRecord, 'id'>;
  presets!: EntityTable<StoredPresetRecord, 'id'>;
  customServices!: EntityTable<StoredCustomServiceRecord, 'id'>;
  meta!: EntityTable<StoredMetaRecord, 'key'>;

  constructor() {
    super('infrasim-db');
    this.version(1).stores({
      designs: 'id, updatedAt',
      presets: 'id, updatedAt',
      meta: 'key',
    });
    this.version(2).stores({
      designs: 'id, updatedAt',
      presets: 'id, updatedAt',
      customServices: 'id, updatedAt',
      meta: 'key',
    });
  }
}

let dbInstance: InfraSimDatabase | null = null;

function getDb(): InfraSimDatabase | null {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return null;
  }
  if (!dbInstance) {
    dbInstance = new InfraSimDatabase();
  }
  return dbInstance;
}

/** Persists a design document to IndexedDB and marks it as the active workspace design. */
export async function saveDesignToIndexedDb(design: Design): Promise<void> {
  const db = getDb();
  if (!db) {
    return;
  }
  await db.transaction('rw', db.designs, db.meta, async () => {
    await db.designs.put({
      id: design.id,
      name: design.name,
      updatedAt: Date.now(),
      doc: structuredClone(design),
    });
    await db.meta.put({ key: 'activeDesignId', value: design.id });
  });
}

/** Loads the most recently active autosaved design from IndexedDB if present. */
export async function loadActiveDesignFromIndexedDb(): Promise<Design | null> {
  const db = getDb();
  if (!db) {
    return null;
  }
  const activeMeta = await db.meta.get('activeDesignId');
  if (activeMeta?.value) {
    const match = await db.designs.get(activeMeta.value);
    if (match?.doc) {
      return match.doc;
    }
  }
  const latest = await db.designs.orderBy('updatedAt').reverse().first();
  return latest?.doc ?? null;
}

/** Saves a user Latency & Mock preset to IndexedDB. */
export async function savePresetToIndexedDb(preset: CustomPreset): Promise<void> {
  const db = getDb();
  if (!db) {
    return;
  }
  await db.presets.put({
    id: preset.id,
    name: preset.name,
    updatedAt: Date.now(),
    preset: structuredClone(preset),
  });
}

/** Lists saved user presets from IndexedDB newest first. */
export async function loadPresetsFromIndexedDb(): Promise<CustomPreset[]> {
  const db = getDb();
  if (!db) {
    return [];
  }
  const rows = await db.presets.orderBy('updatedAt').reverse().toArray();
  return rows.map((row) => row.preset);
}

/** Persists a custom service definition to IndexedDB. */
export async function saveCustomServiceToIndexedDb(
  service: CustomServiceDefinition,
): Promise<void> {
  const db = getDb();
  if (!db) {
    return;
  }
  await db.customServices.put({
    id: service.id,
    name: service.name,
    updatedAt: Date.now(),
    service: structuredClone(service),
  });
}

/** Loads all user custom services from IndexedDB newest first. */
export async function loadCustomServicesFromIndexedDb(): Promise<CustomServiceDefinition[]> {
  const db = getDb();
  if (!db) {
    return [];
  }
  const rows = await db.customServices.orderBy('updatedAt').reverse().toArray();
  return rows.map((row) => row.service);
}

/** Removes a custom service definition from IndexedDB. */
export async function deleteCustomServiceFromIndexedDb(serviceId: string): Promise<void> {
  const db = getDb();
  if (!db) {
    return;
  }
  await db.customServices.delete(serviceId);
}
