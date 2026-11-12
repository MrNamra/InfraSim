import * as Comlink from 'comlink';
import {
  importTerraformJson,
  type TerraformImportOptions,
  type TerraformImportResult,
} from '@infrasim/terraform';

/** Comlink worker RPC surface exposed by `terraformImport.worker.ts`. */
export interface TerraformImportWorkerApi {
  importJson: (rawJson: string, options?: TerraformImportOptions) => Promise<TerraformImportResult>;
}

const workerApi: TerraformImportWorkerApi = {
  async importJson(rawJson, options) {
    return importTerraformJson(rawJson, options);
  },
};

Comlink.expose(workerApi);
