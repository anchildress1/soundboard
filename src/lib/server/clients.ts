import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Storage } from '@google-cloud/storage';
import { required } from './env';

let firestore: Firestore | undefined;
let storage: Storage | undefined;
let secrets: SecretManagerServiceClient | undefined;

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

/** Drops cached clients so tests can swap env vars between cases. */
export function resetClients(): void {
  firestore = undefined;
  storage = undefined;
  secrets = undefined;
}
