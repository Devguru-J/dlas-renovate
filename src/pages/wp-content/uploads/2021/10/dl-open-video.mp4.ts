import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';

// about 페이지 영상.
//
// 정적 자산으로 두면 Cloudflare Workers가 Range 요청에 206을 주지 않고 200과 함께
// 전체 파일을 반환한다. 원본 서버(Apache)는 Accept-Ranges: bytes로 206을 주던 기능이라
// 미러링 과정에서 잃은 회귀다. iOS 사파리는 Range 지원을 재생의 전제로 요구하므로
// 아이폰에서 재생이 아예 되지 않고, 데스크톱에서도 탐색이 불가능하며 재생이 stall한다.
//
// R2는 부분 읽기를 지원하므로 워커가 직접 Range를 처리해 206을 반환한다.
export const prerender = false;

const KEY = 'dl-open-video.mp4';

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  // "bytes=-500" — 마지막 500바이트
  if (rawStart === '') {
    if (rawEnd === '') return null;
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= size) return null;

  // "bytes=500-" — 500부터 끝까지
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export const GET: APIRoute = async ({ request }) => {
  const bucket = (cfEnv as unknown as { MEDIA: R2Bucket }).MEDIA;

  try {
    const rangeHeader = request.headers.get('range');
    const base = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      // 영상은 바뀌지 않는다. 원본 파일명이 곧 버전이므로 길게 캐시한다.
      'cache-control': 'public, max-age=31536000, immutable',
    };

    if (!rangeHeader) {
      const object = await bucket.get(KEY);
      if (!object) return new Response('Not found', { status: 404 });
      return new Response(object.body, {
        headers: { ...base, 'content-length': String(object.size), etag: object.httpEtag },
      });
    }

    // Range 헤더가 있으면 크기를 먼저 알아야 경계를 계산할 수 있다.
    const head = await bucket.head(KEY);
    if (!head) return new Response('Not found', { status: 404 });

    const parsed = parseRange(rangeHeader, head.size);
    if (!parsed) {
      // 범위가 잘못됐음을 알리고 전체 크기를 돌려준다.
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { ...base, 'content-range': `bytes */${head.size}` },
      });
    }

    const { start, end } = parsed;
    const object = await bucket.get(KEY, { range: { offset: start, length: end - start + 1 } });
    if (!object) return new Response('Not found', { status: 404 });

    return new Response(object.body, {
      status: 206,
      headers: {
        ...base,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${head.size}`,
        etag: object.httpEtag,
      },
    });
  } catch (err) {
    console.error('video serve failed', err);
    return new Response('영상을 불러오지 못했습니다.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
};
