import astro from '@astrojs/cloudflare/entrypoints/server';
import { canonicalHostRedirect } from './lib/canonical-host';
import { runCrmRetry, type CrmRetryBucket } from './lib/forms/crm-retry';
import { crmConfig, readEnv } from './lib/forms/env';

/**
 * 워커 엔트리포인트.
 *
 * 어댑터 기본 엔트리(@astrojs/cloudflare/entrypoints/server)는 fetch만 내보내는데
 * Cron 트리거는 scheduled 핸들러를 요구한다. 그래서 그 fetch를 손대지 않고 그대로
 * 재수출하고 scheduled만 얹는다 — 사이트 요청 처리 경로는 여기서 아무것도 바뀌지 않는다.
 * (wrangler.jsonc의 main이 이 파일을 가리킨다.)
 *
 * scheduled가 하는 일은 하나다: 아직 CRM에 못 보낸 리드를 다시 보낸다.
 * 판단 로직은 전부 lib/forms/crm-retry.ts에 있고 여기서는 환경만 엮는다.
 */
export default {
  // www로 들어온 요청만 apex로 넘기고, 나머지는 어댑터 fetch에 그대로 넘긴다.
  // 사이트 처리 경로는 여전히 아무것도 바뀌지 않는다.
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response> {
    return canonicalHostRedirect(request) ?? astro.fetch(request, env as never, ctx);
  },

  scheduled(_controller: ScheduledController, env: unknown, ctx: ExecutionContext): void {
    ctx.waitUntil(retryCrm(env));
  },
};

async function retryCrm(source: unknown): Promise<void> {
  try {
    const env = readEnv(source as Record<string, unknown>);
    const crm = crmConfig(env);
    // 시크릿이 없으면 연동이 꺼져 있는 것이다. 조회조차 하지 않는다.
    if (!crm) return;

    const bucket = (source as { FORM_UPLOADS?: CrmRetryBucket }).FORM_UPLOADS;
    if (!bucket) throw new Error('FORM_UPLOADS 바인딩이 없습니다.');

    const summary = await runCrmRetry({
      supabase: { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey },
      crm,
      bucket,
      mail: { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
    });

    // 집어 온 게 없으면 조용히 끝낸다. 10분마다 도는 크론이 매번 로그를 남기면
    // 정작 봐야 할 줄이 묻힌다.
    if (summary.picked > 0) console.log('crm retry', JSON.stringify(summary));
  } catch (err) {
    // 크론이 죽어도 사이트는 멀쩡해야 하고, 다음 회차가 다시 시도한다.
    console.error('crm retry 실패', err);
  }
}
