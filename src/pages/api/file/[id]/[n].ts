import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { verifyFileToken } from '../../../../lib/forms/token';
import { fetchAttachments } from '../../../../lib/forms/db';
import { MAX_FILES } from '../../../../lib/forms/files';
import { readFileEnv } from '../../../../lib/forms/env';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params, url }) => {
  try {
    return await handleDownload({ params, url });
  } catch (err) {
    // readFileEnv(설정 누락), Supabase 조회, R2 조회 어디서 터져도 여기서 멈춘다.
    // 원인은 로그로만 남기고 응답 본문에는 환경변수나 시크릿을 절대 싣지 않는다.
    console.error('unhandled error in file download endpoint', err);
    return new Response('파일을 내려받는 중 오류가 발생했습니다. 담당자에게 문의해 주세요.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
};

async function handleDownload({
  params,
  url,
}: {
  params: Partial<Record<string, string>>;
  url: URL;
}): Promise<Response> {
  const env = readFileEnv(cfEnv as unknown as Record<string, unknown>);
  const id = params.id ?? '';
  const n = Number(params.n);
  const token = url.searchParams.get('t') ?? '';

  // 상한은 제출 엔드포인트가 서명을 발급하는 범위(MAX_FILES)와 반드시 같아야 한다.
  if (!UUID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > MAX_FILES) {
    return new Response('Not found', { status: 404 });
  }

  const verdict = await verifyFileToken(env.fileTokenSecret, id, n, token, Date.now());
  if (verdict === 'expired') {
    return new Response('이 링크는 만료되었습니다. 담당자에게 재발급을 요청해 주세요.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (verdict === 'invalid') {
    // 존재 여부를 흘리지 않기 위해 만료와 다른 응답을 준다
    return new Response('Not found', { status: 404 });
  }

  const attachments = await fetchAttachments(
    { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey },
    id,
  );
  const meta = attachments.find((a) => a.n === n);
  if (!meta) return new Response('Not found', { status: 404 });

  const bucket = (cfEnv as unknown as { FORM_UPLOADS: R2Bucket }).FORM_UPLOADS;
  const object = await bucket.get(meta.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': meta.content_type,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
