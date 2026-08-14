/**
 * 워커 런타임에서 응답을 보낸 뒤에도 남은 일을 끝내게 해 주는 훅.
 * 실제로 부르는 메서드만 구조로 좁힌다 — 어댑터의 타입에 묶이지 않기 위함이다.
 */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Astro의 locals에서 waitUntil을 꺼낸다. 없으면 null이다.
 *
 * 어댑터(@astrojs/cloudflare)는 이것을 `locals.cfContext`에 넣는다.
 * 예전 자리인 `locals.runtime.ctx`는 Astro v6에서 제거됐는데, 단순히 없어진 것이
 * 아니라 **읽기만 해도 예외를 던지는 게터**로 남아 있다. 그래서 이 함수는 통째로
 * try 안에서 찾는다 — 여기서 예외가 새어나가면 CRM 전송 여부와 무관하게 제출
 * 자체가 실패 응답으로 바뀐다(실제로 그렇게 됐던 적이 있다).
 *
 * null이면 호출부는 그냥 await하면 된다. 느려질 뿐 결과는 같다.
 */
export function waitUntilCtx(locals: unknown): WaitUntilCtx | null {
  try {
    if (typeof locals !== 'object' || locals === null) return null;
    const ctx = (locals as { cfContext?: unknown }).cfContext;
    if (typeof ctx !== 'object' || ctx === null) return null;
    const waitUntil = (ctx as { waitUntil?: unknown }).waitUntil;
    return typeof waitUntil === 'function' ? (ctx as WaitUntilCtx) : null;
  } catch {
    return null;
  }
}
