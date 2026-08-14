/*
 * 컨택폼 엔드포인트의 속도 제한.
 *
 * 세 겹으로 나눠 서로 다른 공격을 막는다.
 *  1. 버스트(같은 IP가 "따라라락" 연속 투하)      → 초/분 단위 IP 리밋
 *  2. 봇넷(수많은 IP가 조금씩 나눠 던짐)          → 전역 분당 리밋(마지막 방벽)
 *  3. 저속 드립(리밋을 파악해 3초마다 한 건씩)    → IP별 일일 누적 상한(Supabase, 별도 모듈)
 *
 * 여기(1·2)는 Cloudflare의 네이티브 Rate Limiting 바인딩을 쓴다. 엣지에서 값이
 * 유지되므로 Supabase에 닿기 전에 요청을 흘려버릴 수 있다 — 즉 이 검사 자체가
 * DoS 증폭 경로가 되지 않는다. DB를 세는 3번은 반드시 이 검사를 통과한 요청에만 돌린다.
 *
 * 바인딩이 없으면(로컬 dev·테스트) 조용히 통과시킨다. 방어는 운영에서만 필요하고,
 * 없다고 폼이 죽으면 안 된다.
 */

/** Cloudflare Rate Limiting 바인딩의 최소 형태. limit()만 쓴다. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitBindings {
  /** IP당 리밋 */
  perIp?: RateLimiter | null;
  /** 전역 리밋(모든 IP 합산) */
  global?: RateLimiter | null;
}

export type RateLimitOutcome =
  | { ok: true }
  | { ok: false; scope: 'ip' | 'global' };

/**
 * IP 리밋 → 전역 리밋 순으로 본다. 하나라도 막히면 즉시 반환한다.
 * IP를 먼저 보는 이유: 대부분의 공격은 소수 IP에서 오므로, 그걸 먼저 쳐내면
 * 전역 카운터가 정상 사용자 몫으로 남는다.
 *
 * key가 없으면(IP 헤더가 없는 비정상 요청) IP 리밋은 건너뛰고 전역만 적용한다 —
 * 빈 key로 전 요청을 한 버킷에 몰아넣어 정상 사용자를 함께 막는 일을 피한다.
 */
export async function checkRateLimit(
  bindings: RateLimitBindings,
  ip: string | null,
): Promise<RateLimitOutcome> {
  if (bindings.perIp && ip) {
    const r = await bindings.perIp.limit({ key: ip });
    if (!r.success) return { ok: false, scope: 'ip' };
  }
  if (bindings.global) {
    const r = await bindings.global.limit({ key: 'all' });
    if (!r.success) return { ok: false, scope: 'global' };
  }
  return { ok: true };
}

/** cfEnv에서 리밋 바인딩을 꺼낸다. 없으면 null(=검사 생략). */
export function readRateLimitBindings(source: Record<string, unknown>): RateLimitBindings {
  const asLimiter = (v: unknown): RateLimiter | null =>
    v !== null && typeof v === 'object' && typeof (v as RateLimiter).limit === 'function'
      ? (v as RateLimiter)
      : null;
  return {
    perIp: asLimiter(source['RL_PER_IP']),
    global: asLimiter(source['RL_GLOBAL']),
  };
}
