import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from '../../src/lib/forms/turnstile';

describe('verifyTurnstile', () => {
  it('success:true면 통과다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 });
    expect(await verifyTurnstile('secret', 'token', '1.2.3.4', fake)).toBe(true);
  });

  it('success:false면 실패다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      });
    expect(await verifyTurnstile('secret', 'token', null, fake)).toBe(false);
  });

  it('토큰이 없으면 API를 부르지 않고 실패다', async () => {
    let called = false;
    const fake: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    expect(await verifyTurnstile('secret', null, null, fake)).toBe(false);
    expect(await verifyTurnstile('secret', '', null, fake)).toBe(false);
    expect(called).toBe(false);
  });

  it('siteverify가 죽으면 실패로 본다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    expect(await verifyTurnstile('secret', 'token', null, fake)).toBe(false);
  });

  it('IP가 있으면 remoteip로 함께 보낸다', async () => {
    let body: URLSearchParams | null = null;
    const fake: typeof fetch = async (_url, init) => {
      body = (init as RequestInit).body as URLSearchParams;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    await verifyTurnstile('secret', 'token', '9.9.9.9', fake);
    expect(body!.get('secret')).toBe('secret');
    expect(body!.get('response')).toBe('token');
    expect(body!.get('remoteip')).toBe('9.9.9.9');
  });
});
