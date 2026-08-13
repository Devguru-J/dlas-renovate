import type { APIRoute } from 'astro';

// Google Search Console 소유권 인증 파일.
// 정적 자산으로 두면 Cloudflare Workers가 .html 확장자를 떼며 307로 보내고,
// Google 인증기는 리다이렉트를 따라가지 않아 인증이 실패한다.
// 워커가 직접 서빙해 확장자 붙은 경로에서 200을 반환한다.
export const prerender = false;

export const GET: APIRoute = () =>
  new Response('google-site-verification: google67d529f83e970cd0.html', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
