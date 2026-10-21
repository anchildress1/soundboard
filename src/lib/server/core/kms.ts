import { keyManagement } from './clients';
import { kmsKey } from './env';

// Never log either value or set it on a span: the plaintext is a live refresh token.

/** Encrypts with `KMS_KEY`; returns base64 ciphertext. */
export async function encrypt(plain: string): Promise<string> {
  const [response] = await keyManagement().encrypt({
    name: kmsKey(),
    plaintext: Buffer.from(plain, 'utf8'),
  });
  if (!response.ciphertext) throw new Error('KMS returned no ciphertext');
  return Buffer.from(response.ciphertext).toString('base64');
}

/** Decrypts base64 ciphertext from `encrypt`. */
export async function decrypt(cipher: string): Promise<string> {
  const [response] = await keyManagement().decrypt({
    name: kmsKey(),
    ciphertext: Buffer.from(cipher, 'base64'),
  });
  if (!response.plaintext) throw new Error('KMS returned no plaintext');
  return Buffer.from(response.plaintext).toString('utf8');
}
