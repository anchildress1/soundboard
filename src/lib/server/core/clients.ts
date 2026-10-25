import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Storage } from '@google-cloud/storage';
import { resetDb } from '#lib/server/core/db.js';
import { required } from './env';

let storage: Storage | null = null;
let kms: KeyManagementServiceClient | null = null;

export function bucket() {
  storage ??= new Storage({ projectId: required('GCP_PROJECT_ID') });
  return storage.bucket(required('GCS_BUCKET'));
}

export function keyManagement(): KeyManagementServiceClient {
  kms ??= new KeyManagementServiceClient();
  return kms;
}

/** Drops cached clients and the database pool so tests can swap env vars between cases. */
export function resetClients(): void {
  storage = null;
  kms = null;
  resetDb();
}
