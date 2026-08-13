import { describe, it, expect } from 'vitest';
import {
  FILE_TOKEN_TTL_MS, signFileToken, verifyFileToken, hashIp,
} from '../../src/lib/forms/token';

const SECRET = 'test-secret-do-not-use';
const ID = '11111111-2222-3333-4444-555555555555';
const NOW = 1_800_000_000_000;

describe('signFileToken / verifyFileToken', () => {
  it('TTL은 7일이다', () => {
    expect(FILE_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('정상 토큰을 통과시킨다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + FILE_TOKEN_TTL_MS);
    expect(await verifyFileToken(SECRET, ID, 1, t, NOW)).toBe('ok');
  });

  it('만료된 토큰은 expired다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW - 1);
    expect(await verifyFileToken(SECRET, ID, 1, t, NOW)).toBe('expired');
  });

  it('다른 제출 ID로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken(SECRET, 'other-id', 1, t, NOW)).toBe('invalid');
  });

  it('다른 순번으로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken(SECRET, ID, 2, t, NOW)).toBe('invalid');
  });

  it('다른 시크릿으로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken('another-secret', ID, 1, t, NOW)).toBe('invalid');
  });

  it('만료시각만 늘린 변조 토큰을 거부한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    const sig = t.split('.')[1];
    const tampered = `${NOW + 999_999_999}.${sig}`;
    expect(await verifyFileToken(SECRET, ID, 1, tampered, NOW)).toBe('invalid');
  });

  it('형식이 깨진 토큰을 거부한다', async () => {
    for (const bad of ['', 'abc', '123', '.', 'abc.def', `${NOW + 1000}.`]) {
      expect(await verifyFileToken(SECRET, ID, 1, bad, NOW)).toBe('invalid');
    }
  });
});

describe('hashIp', () => {
  it('같은 입력은 같은 해시를 낸다', async () => {
    expect(await hashIp(SECRET, '1.2.3.4')).toBe(await hashIp(SECRET, '1.2.3.4'));
  });

  it('다른 IP는 다른 해시를 낸다', async () => {
    expect(await hashIp(SECRET, '1.2.3.4')).not.toBe(await hashIp(SECRET, '1.2.3.5'));
  });

  it('원본 IP가 결과에 남지 않는다', async () => {
    const h = await hashIp(SECRET, '1.2.3.4');
    expect(h).not.toContain('1.2.3.4');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
