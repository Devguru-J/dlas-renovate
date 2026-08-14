import { describe, it, expect } from 'vitest';
import {
  countRecentByIpHash,
  isIpOverDailyCap,
  DAILY_IP_CAP,
  IP_CAP_WINDOW_MS,
} from '../../src/lib/forms/ipcap';

const CFG = { url: 'https://proj.supabase.co', serviceRoleKey: 'service-key' };
const NOW = new Date('2026-08-14T20:10:00.000Z');

function counted(total: number, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return async (url, init) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init as RequestInit;
    }
    return new Response(null, {
      status: 206,
      headers: { 'content-range': `0-0/${total}` },
    });
  };
}

describe('countRecentByIpHash', () => {
  it('Content-Range의 총계를 읽는다', async () => {
    expect(await countRecentByIpHash(CFG, 'h', NOW, counted(37))).toBe(37);
  });

  it('ip_hash와 24시간 창으로 조회하고 본문은 받지 않는다', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    await countRecentByIpHash(CFG, 'abc123', NOW, counted(0, cap));

    expect(cap.url).toContain('ip_hash=eq.abc123');
    const since = new Date(NOW.getTime() - IP_CAP_WINDOW_MS).toISOString();
    expect(cap.url).toContain(`created_at=gte.${encodeURIComponent(since)}`);
    expect(cap.init?.method).toBe('HEAD');
    expect((cap.init?.headers as Record<string, string>).Prefer).toBe('count=exact');
  });

  it('조회가 실패하면 null (호출부가 통과시키도록)', async () => {
    const fail: typeof fetch = async () => new Response('nope', { status: 500 });
    expect(await countRecentByIpHash(CFG, 'h', NOW, fail)).toBeNull();
  });

  it('Content-Range가 없으면 null', async () => {
    const noHeader: typeof fetch = async () => new Response(null, { status: 206 });
    expect(await countRecentByIpHash(CFG, 'h', NOW, noHeader)).toBeNull();
  });

  it('네트워크 예외도 null로 삼킨다', async () => {
    const boom: typeof fetch = async () => {
      throw new Error('network down');
    };
    expect(await countRecentByIpHash(CFG, 'h', NOW, boom)).toBeNull();
  });
});

describe('isIpOverDailyCap', () => {
  it('상한 미만이면 통과', async () => {
    expect(await isIpOverDailyCap(CFG, 'h', NOW, counted(DAILY_IP_CAP - 1))).toBe(false);
  });

  it('상한에 닿으면 막는다', async () => {
    expect(await isIpOverDailyCap(CFG, 'h', NOW, counted(DAILY_IP_CAP))).toBe(true);
    expect(await isIpOverDailyCap(CFG, 'h', NOW, counted(DAILY_IP_CAP + 500))).toBe(true);
  });

  it('ip_hash가 없으면 셀 수 없으므로 통과 — 정상 사용자를 막지 않는다', async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return new Response(null, { status: 206, headers: { 'content-range': '0-0/999' } });
    };
    expect(await isIpOverDailyCap(CFG, null, NOW, spy)).toBe(false);
    expect(called).toBe(false);
  });

  it('Supabase 조회 실패는 fail-open — 문의를 잃는 것보다 낫다', async () => {
    const fail: typeof fetch = async () => new Response('boom', { status: 503 });
    expect(await isIpOverDailyCap(CFG, 'h', NOW, fail)).toBe(false);
  });
});
