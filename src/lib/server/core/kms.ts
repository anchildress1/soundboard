import { keyManagement } from './clients';
import { within } from './deadline';
import { kmsKey } from './env';

// Never log either value or set it on a span: the plaintext is a live credential (a refresh token or
// an upload session URI).

/** KMS budget on the browser-upload path. */
export const UPLOAD_KMS_MS = 5_000;

/** `timeout` bounds the whole call, gax retries included; without it the SDK's defaults apply. */
export type KmsOptions = { timeout?: number };

const bounded = <T>(work: Promise<T>, what: string, timeout?: number) =>
  timeout === undefined ? work : within(timeout, work, what);

/** Encrypts with `KMS_KEY`; returns base64 ciphertext. */
export async function encrypt(plain: string, { timeout }: KmsOptions = {}): Promise<string> {
  const request = { name: kmsKey(), plaintext: Buffer.from(plain, 'utf8') };
  const [response] = await bounded(
    timeout === undefined
      ? keyManagement().encrypt(request)
      : keyManagement().encrypt(request, { timeout }),
    'KMS encrypt',
    timeout,
  );
  if (!response.ciphertext) throw new Error('KMS returned no ciphertext');
  return Buffer.from(response.ciphertext).toString('base64');
}

/** Decrypts base64 ciphertext from `encrypt`. */
export async function decrypt(cipher: string, { timeout }: KmsOptions = {}): Promise<string> {
  const request = { name: kmsKey(), ciphertext: Buffer.from(cipher, 'base64') };
  const [response] = await bounded(
    timeout === undefined
      ? keyManagement().decrypt(request)
      : keyManagement().decrypt(request, { timeout }),
    'KMS decrypt',
    timeout,
  );
  if (!response.plaintext) throw new Error('KMS returned no plaintext');
  return Buffer.from(response.plaintext).toString('utf8');
}
