import { Firestore } from '@google-cloud/firestore';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Storage } from '@google-cloud/storage';
import { resetDb } from '$lib/server/core/db';
import { required } from './env';

let firestore: Firestore | null = null;
let storage: Storage | null = null;
let secrets: SecretManagerServiceClient | null = null;
let kms: KeyManagementServiceClient | null = null;

export function db(): Firestore {
  firestore ??= new Firestore({
    projectId: required('GCP_PROJECT_ID'),
    ignoreUndefinedProperties: true,
  });
  return firestore;
}

export function bucket() {
  storage ??= new Storage({ projectId: required('GCP_PROJECT_ID') });
  return storage.bucket(required('GCS_BUCKET'));
}

export function secretManager(): SecretManagerServiceClient {
  secrets ??= new SecretManagerServiceClient();
  return secrets;
}

export function keyManagement(): KeyManagementServiceClient {
  kms ??= new KeyManagementServiceClient();
  return kms;
}

/** Drops cached clients so tests can swap env vars between cases. */
export function resetClients(): void {
  firestore = null;
  storage = null;
  secrets = null;
  kms = null;
  resetDb();
}
