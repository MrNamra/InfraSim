import { SCHEMA_VERSION } from '@infrasim/shared-types';

/** Returns the supported design schema version for the discrete-event engine. */
export function getEngineSchemaVersion(): number {
  return SCHEMA_VERSION;
}
