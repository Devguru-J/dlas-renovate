/**
 * 정규 호스트 리다이렉트.
 *
 * 원본 카페24는 `http://www.dlas.co.kr/`을 `https://dlas.co.kr/`로 301 보냈다(2026-08-16 실측).
 * 도메인 이전 후에도 같은 동작을 유지해야 중복 콘텐츠가 생기지 않고, 사이트 전체의
 * canonical·og·JSON-LD가 이미 apex 절대 URL이라 그쪽과도 어긋나지 않는다.
 *
 * 대상은 **열거된 호스트만**이다. "apex가 아니면 전부 보낸다"로 짜면
 * `dlas.dolcejian.workers.dev`(전환 롤백 경로)와 로컬 개발 주소까지 끌려 들어간다.
 */

/** 이 호스트로 들어온 요청을 apex로 넘긴다. 소문자로 비교한다. */
const REDIRECT_FROM = new Set(['www.dlas.co.kr']);

const CANONICAL_ORIGIN = 'https://dlas.co.kr';

/**
 * 넘겨야 하면 리다이렉트 응답을, 아니면 null을 준다.
 * null이면 호출자는 평소대로 요청을 처리하면 된다.
 */
export function canonicalHostRedirect(request: Request): Response | null {
  const method = request.method.toUpperCase();

  // 문서 요청(GET/HEAD)만 넘긴다.
  //
  // POST를 넘기려던 적이 있었는데(308) 폼이 통째로 죽었다. www에서 폼을 열면
  // action이 상대경로라 제출도 www로 가는데, 308은 **교차 출처** 리다이렉트가 된다.
  // 브라우저는 따라가지만 apex가 Access-Control-Allow-Origin을 주지 않으므로
  // fetch가 실패하고, CF7은 성공도 실패도 아닌 상태로 스피너만 돌린다.
  // (301을 쓰면 본문 없는 GET이 되어 문의가 조용히 사라진다 — 그것도 답이 아니다.)
  //
  // 같은 호스트에서 그냥 처리하는 게 옳다. Origin과 Host가 일치하니 Astro CSRF도 통과하고,
  // 어차피 페이지 로드 시점의 301로 대부분의 방문자는 apex에서 폼을 연다.
  if (method !== 'GET' && method !== 'HEAD') return null;

  const url = new URL(request.url);
  if (!REDIRECT_FROM.has(url.hostname.toLowerCase())) return null;

  const target = new URL(url.pathname + url.search, CANONICAL_ORIGIN);

  return new Response(null, {
    status: 301,
    headers: { location: target.toString() },
  });
}
