// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { decrypt, encrypt } from '$lib/server/core/kms';

const KEY = 'projects/p/locations/us-central1/keyRings/soundboard/cryptoKeys/refresh-tokens';

const kms = vi.hoisted(() => ({ created: 0, encrypt: vi.fn(), decrypt: vi.fn() }));

vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    encrypt = kms.encrypt;
    decrypt = kms.decrypt;
    constructor() {
      kms.created++;
    }
  },
}));

beforeEach(() => {
  vi.stubEnv('KMS_KEY', KEY);
  resetClients();
  vi.clearAllMocks();
  kms.created = 0;
});

describe('encrypt', () => {
  it('encrypts the UTF-8 bytes with KMS_KEY and returns base64', async () => {
    kms.encrypt.mockResolvedValueOnce([{ ciphertext: Buffer.from('sealed') }]);
    expect(await encrypt('1//refresh')).toBe(Buffer.from('sealed').toString('base64'));
    expect(kms.encrypt).toHaveBeenCalledWith({ name: KEY, plaintext: Buffer.from('1//refresh') });
  });

  it('reuses one client until clients are reset', async () => {
    kms.encrypt.mockResolvedValue([{ ciphertext: Buffer.from('x') }]);
    await encrypt('a');
    await encrypt('b');
    expect(kms.created).toBe(1);
    resetClients();
    await encrypt('c');
    expect(kms.created).toBe(2);
  });

  it('throws when KMS returns no ciphertext', async () => {
    kms.encrypt.mockResolvedValueOnce([{ ciphertext: null }]);
    await expect(encrypt('a')).rejects.toThrow('KMS returned no ciphertext');
  });

  it('propagates KMS errors without the plaintext in them', async () => {
    kms.encrypt.mockRejectedValueOnce(Object.assign(new Error('PERMISSION_DENIED'), { code: 7 }));
    const error = await encrypt('1//secret-token').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('1//secret-token');
  });

  it('throws before calling KMS when KMS_KEY is unset', async () => {
    vi.stubEnv('KMS_KEY', '');
    await expect(encrypt('a')).rejects.toThrow('Missing required env var KMS_KEY');
    expect(kms.encrypt).not.toHaveBeenCalled();
  });
});

describe('decrypt', () => {
  it('decodes base64 and returns the UTF-8 plaintext', async () => {
    kms.decrypt.mockResolvedValueOnce([{ plaintext: Buffer.from('1//refresh') }]);
    const cipher = Buffer.from('sealed').toString('base64');
    expect(await decrypt(cipher)).toBe('1//refresh');
    expect(kms.decrypt).toHaveBeenCalledWith({ name: KEY, ciphertext: Buffer.from('sealed') });
  });

  it('round-trips non-ASCII text', async () => {
    kms.encrypt.mockImplementationOnce(async ({ plaintext }: { plaintext: Buffer }) => [
      { ciphertext: plaintext },
    ]);
    kms.decrypt.mockImplementationOnce(async ({ ciphertext }: { ciphertext: Buffer }) => [
      { plaintext: ciphertext },
    ]);
    expect(await decrypt(await encrypt('tökén ✓'))).toBe('tökén ✓');
  });

  it('throws when KMS returns no plaintext', async () => {
    kms.decrypt.mockResolvedValueOnce([{ plaintext: null }]);
    await expect(decrypt('AA==')).rejects.toThrow('KMS returned no plaintext');
  });

  it('propagates KMS errors', async () => {
    kms.decrypt.mockRejectedValueOnce(new Error('INVALID_ARGUMENT'));
    await expect(decrypt('AA==')).rejects.toThrow('INVALID_ARGUMENT');
  });
});
