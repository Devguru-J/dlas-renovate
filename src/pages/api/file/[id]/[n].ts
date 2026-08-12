import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { verifyFileToken } from '../../../../lib/forms/token';
import { fetchAttachments } from '../../../../lib/forms/db';
import { readEnv } from '../../../../lib/forms/env';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params, url }) => {
  const env = readEnv(cfEnv as unknown as Record<string, unknown>);
  const id = params.id ?? '';
  const n = Number(params.n);
  const token = url.searchParams.get('t') ?? '';

  if (!UUID_RE.test(id) || !(n === 1 || n === 2)) {
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
    },
  });
};
