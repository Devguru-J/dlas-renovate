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
  const url = new URL(request.url);
  if (!REDIRECT_FROM.has(url.hostname.toLowerCase())) return null;

  const target = new URL(url.pathname + url.search, CANONICAL_ORIGIN);

  // GET/HEAD는 301이 정답이다(원본 동작이고 검색엔진이 링크 가치를 넘긴다).
  // 그 외 메서드에 301을 쓰면 브라우저가 본문 없는 GET으로 바꿔 버려 폼 제출이
  // 흔적도 없이 사라진다. 308은 메서드와 본문을 그대로 유지한다.
  const method = request.method.toUpperCase();
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;

  return new Response(null, {
    status,
    headers: { location: target.toString() },
  });
}
