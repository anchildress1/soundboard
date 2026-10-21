// Stands in for @google-cloud/kms in the E2E build (vite.config.ts, E2E_FAKES=1). Reversible, not
// secret: the "ciphertext" is the plaintext behind a marker, so fixtures can seed it directly.
const MARKER = Buffer.from('e2e-kms:');

type Bytes = Uint8Array | string | null | undefined;

const bytes = (value: Bytes) => Buffer.from(value ?? '');

export class KeyManagementServiceClient {
  async encrypt({ plaintext }: { name: string; plaintext: Bytes }) {
    return [{ ciphertext: Buffer.concat([MARKER, bytes(plaintext)]) }] as const;
  }

  async decrypt({ ciphertext }: { name: string; ciphertext: Bytes }) {
    const sealed = bytes(ciphertext);
    if (!sealed.subarray(0, MARKER.length).equals(MARKER)) throw new Error('INVALID_ARGUMENT');
    return [{ plaintext: sealed.subarray(MARKER.length) }] as const;
  }
}
