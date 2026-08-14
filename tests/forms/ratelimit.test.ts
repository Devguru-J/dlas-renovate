import { describe, it, expect } from 'vitest';
import {
  checkRateLimit,
  readRateLimitBindings,
  shouldAlert,
  type RateLimiter,
} from '../../src/lib/forms/ratelimit';

function limiter(success: boolean, seen: string[] = []): RateLimiter {
  return {
    limit: async ({ key }) => {
      seen.push(key);
      return { success };
    },
  };
}

describe('checkRateLimit', () => {
  it('둘 다 통과하면 ok', async () => {
    const r = await checkRateLimit({ perIp: limiter(true), global: limiter(true) }, '1.2.3.4');
    expect(r).toEqual({ ok: true });
  });

  it('IP 리밋에 걸리면 scope=ip로 막고 전역은 보지 않는다', async () => {
    const globalSeen: string[] = [];
    const r = await checkRateLimit(
      { perIp: limiter(false), global: limiter(true, globalSeen) },
      '1.2.3.4',
    );
    expect(r).toEqual({ ok: false, scope: 'ip' });
    // 이미 막았으므로 전역 카운터를 소비하지 않는다 — 공격자가 전역 버킷을
    // 대신 태워 정상 사용자를 막는 일을 피한다.
    expect(globalSeen).toEqual([]);
  });

  it('IP는 통과해도 전역이 막으면 scope=global', async () => {
    const r = await checkRateLimit({ perIp: limiter(true), global: limiter(false) }, '1.2.3.4');
    expect(r).toEqual({ ok: false, scope: 'global' });
  });

  it('IP 리밋 키로 그 IP를 쓴다', async () => {
    const seen: string[] = [];
    await checkRateLimit({ perIp: limiter(true, seen), global: null }, '203.0.113.9');
    expect(seen).toEqual(['203.0.113.9']);
  });

  it('IPv6는 /64로 묶은 키를 쓴다 — 주소 로테이션으로 우회할 수 없어야 한다', async () => {
    const seen: string[] = [];
    const b = { perIp: limiter(true, seen), global: null };
    await checkRateLimit(b, '2001:db8:1:2:aaaa::1');
    await checkRateLimit(b, '2001:db8:1:2:bbbb::2');
    await checkRateLimit(b, '2001:db8:1:2::3');
    expect(new Set(seen).size).toBe(1);
  });

  it('IP가 없으면 IP 리밋은 건너뛰고 전역만 본다', async () => {
    const ipSeen: string[] = [];
    const r = await checkRateLimit({ perIp: limiter(false, ipSeen), global: limiter(true) }, null);
    // 빈 키로 전 요청을 한 버킷에 몰면 정상 사용자까지 막힌다. 건너뛰는 게 맞다.
    expect(ipSeen).toEqual([]);
    expect(r).toEqual({ ok: true });
  });

  it('바인딩이 없으면(로컬 dev) 통과시킨다', async () => {
    expect(await checkRateLimit({}, '1.2.3.4')).toEqual({ ok: true });
    expect(await checkRateLimit({ perIp: null, global: null }, '1.2.3.4')).toEqual({ ok: true });
  });
});

describe('shouldAlert', () => {
  it('통과하면 true — 1분에 한 번만 열리는 문이다', async () => {
    expect(await shouldAlert({ alert: limiter(true) })).toBe(true);
  });

  it('이미 최근에 보냈으면 false — 공격 중 메일 폭탄을 막는다', async () => {
    expect(await shouldAlert({ alert: limiter(false) })).toBe(false);
  });

  it('바인딩이 없으면 보내지 않는다 — 도배 방지 없는 알림은 그 자체가 사고다', async () => {
    expect(await shouldAlert({})).toBe(false);
  });
});

describe('readRateLimitBindings', () => {
  it('limit 함수를 가진 값만 리미터로 인정한다', () => {
    const real = limiter(true);
    const b = readRateLimitBindings({ RL_PER_IP: real, RL_GLOBAL: 'not-a-limiter' });
    expect(b.perIp).toBe(real);
    expect(b.global).toBeNull();
  });

  it('바인딩이 아예 없으면 전부 null', () => {
    const b = readRateLimitBindings({});
    expect(b.perIp).toBeNull();
    expect(b.global).toBeNull();
    expect(b.alert).toBeNull();
  });

  it('RL_ALERT도 읽는다', () => {
    const a = limiter(true);
    expect(readRateLimitBindings({ RL_ALERT: a }).alert).toBe(a);
  });
});
