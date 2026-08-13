import type { APIRoute } from 'astro';

// 네이버 서치어드바이저 소유권 인증 파일. 사유는 google 쪽과 동일하다.
// 네이버는 DNS 인증 수단이 없어 이 파일이 유일한 소유권 증명이다.
export const prerender = false;

export const GET: APIRoute = () =>
  new Response('naver-site-verification: naver173588dc054ae58605acdcfdada32a75.html', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
