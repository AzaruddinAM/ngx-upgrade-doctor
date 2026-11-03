export class CryptoService {
  private key(): Uint8Array {
    return new Uint8Array(16);
  }
  private params(): { iv: Uint8Array } {
    return { iv: new Uint8Array(12) };
  }
  async encrypt(k: CryptoKey, data: Uint8Array) {
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: this.params().iv }, k, data);
  }
  make() {
    return new Uint8Array(4);
  }
}
