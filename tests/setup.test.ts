import { describe, it, expect } from 'vitest';

describe('test setup', () => {
  it('WebCrypto HMAC를 쓸 수 있다', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('msg'));
    expect(new Uint8Array(sig).length).toBe(32);
  });
});
