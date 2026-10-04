// Stands in for @google-cloud/secret-manager in the E2E build: no channel is ever connected.
export class SecretManagerServiceClient {
  async accessSecretVersion(): Promise<never> {
    throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
  }
}
