/*
 * IP별 일일 누적 상한.
 *
 * 막으려는 공격: 속도 제한을 파악한 뒤 그 한계선 바로 아래로(예: 3초에 한 건씩)
 * 꾸준히 던지는 저속 드립. 버스트 리밋(ratelimit.ts)은 순간 속도만 보므로 이건 통과한다.
 * 그래서 "24시간 안에 같은 IP가 만든 레코드 수"를 세어 상한을 넘으면 거절한다.
 *
 * 버스트 리밋과 달리 이건 Supabase count 쿼리를 한 번 쓴다. 그래서 반드시 버스트 리밋을
 * 통과한 요청에만 돌려야 한다(엔드포인트가 그 순서를 지킨다). 세는 대상은 "레코드"이므로,
 * 빈 값 플러딩(검증 실패라 레코드가 안 생김)은 애초에 여기까지 오지도 않고 세지도 않는다.
 * 즉 이 상한은 "실제로 DB를 채우려는" 제출에만 걸린다.
 *
 * ip_hash가 없으면(cf-connecting-ip 부재) 셀 수 없으므로 통과시킨다 — 정상 사용자를
 * 막느니 이 계층을 건너뛴다. 버스트·전역 리밋과 Turnstile이 여전히 남아 있다.
 */

export interface IpCapConfig {
  url: string;
  serviceRoleKey: string;
}

/** 같은 IP가 24시간 동안 만들 수 있는 최대 레코드 수. */
export const DAILY_IP_CAP = 20;

/** 상한을 세는 창(24시간). */
export const IP_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * ip_hash로 최근 창 안의 레코드 수를 센다. PostgREST의 count=exact를 쓰되
 * 본문은 받지 않는다(Range 0-0 + Prefer: count). 실패하면 null을 돌려주고,
 * 호출부는 null을 "셀 수 없음 → 통과"로 다룬다(fail-open).
 */
export async function countRecentByIpHash(
  cfg: IpCapConfig,
  ipHash: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const base = cfg.url.replace(/\/+$/, '');
  const since = new Date(now.getTime() - IP_CAP_WINDOW_MS).toISOString();
  const params = new URLSearchParams();
  params.set('select', 'id');
  params.set('ip_hash', `eq.${ipHash}`);
  params.set('created_at', `gte.${since}`);

  try {
    const res = await fetchImpl(`${base}/rest/v1/contact_submissions?${params.toString()}`, {
      method: 'HEAD',
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        // count=exact를 요구하고 실제 행은 받지 않는다.
        Prefer: 'count=exact',
        Range: '0-0',
        'Range-Unit': 'items',
      },
    });
    if (!res.ok && res.status !== 206) return null;
    // PostgREST는 총 개수를 Content-Range: 0-0/<total> 로 준다.
    const cr = res.headers.get('content-range');
    if (!cr) return null;
    const slash = cr.lastIndexOf('/');
    if (slash < 0) return null;
    const total = Number.parseInt(cr.slice(slash + 1), 10);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/**
 * 이 IP가 지금 한 건 더 저장해도 되는가.
 * ipHash가 없으면 통과. count가 null(조회 실패)이면 통과(fail-open).
 * 이미 상한 이상이면 막는다.
 */
export async function isIpOverDailyCap(
  cfg: IpCapConfig,
  ipHash: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!ipHash) return false;
  const count = await countRecentByIpHash(cfg, ipHash, now, fetchImpl);
  if (count === null) return false;
  return count >= DAILY_IP_CAP;
}
