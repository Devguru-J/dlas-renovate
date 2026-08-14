import { describe, it, expect } from 'vitest';
import { waitUntilCtx } from '../../src/lib/forms/runtime';

describe('waitUntilCtx', () => {
  it('어댑터가 넣어 준 cfContext에서 waitUntil을 찾는다', () => {
    const ctx = { waitUntil: () => {} };
    expect(waitUntilCtx({ cfContext: ctx })).toBe(ctx);
  });

  // Astro v6의 locals.runtime.ctx는 "제거됐다"고 알리려고 읽기만 해도 던지는 게터다.
  // 여기서 새어나간 예외가 제출 전체를 실패로 만든 적이 있다.
  it('읽기만 해도 던지는 속성이 섞여 있어도 던지지 않는다', () => {
    const locals = {
      get runtime(): never {
        throw new Error('Astro.locals.runtime.ctx has been removed in Astro v6.');
      },
    };
    expect(() => waitUntilCtx(locals)).not.toThrow();
    expect(waitUntilCtx(locals)).toBeNull();
  });

  it('waitUntil이 없으면 null이다', () => {
    expect(waitUntilCtx({ cfContext: {} })).toBeNull();
    expect(waitUntilCtx({})).toBeNull();
    expect(waitUntilCtx(null)).toBeNull();
    expect(waitUntilCtx(undefined)).toBeNull();
  });
});
