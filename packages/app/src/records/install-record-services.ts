/**
 * Builds the record store and install record service every delivery layer uses.
 * @module records/install-record-services
 */
import type {
  RecordFs,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import {
  InstallRecordService,
} from './install-record-service';
import {
  RecordStore,
} from './record-store';

/** Options of {@link createInstallRecordServices}. */
export interface InstallRecordServicesOptions {
  /** Writer stamp for `generatedBy`, e.g. `ai-primitives-hub-cli@0.3.0`. */
  generatedBy: string;
  /** Filesystem port; `NodeRecordFs` by default. */
  fs?: RecordFs;
}

/** The record services one command or view uses. */
export interface InstallRecordServices {
  /** The filesystem port both services use. */
  fs: RecordFs;
  /** Locates, loads and saves record files. */
  store: RecordStore;
  /** Records installs and uninstalls, and removes superseded files. */
  service: InstallRecordService;
}

/**
 * Build a record store and an install record service on one filesystem port.
 * @param options - Writer stamp and optional filesystem port.
 */
export const createInstallRecordServices = (options: InstallRecordServicesOptions): InstallRecordServices => {
  const fs = options.fs ?? new NodeRecordFs();
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: options.generatedBy });
  return { fs, store, service: new InstallRecordService({ store, fs }) };
};
