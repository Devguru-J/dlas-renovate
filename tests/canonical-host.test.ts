import { describe, expect, it } from 'vitest';
import { canonicalHostRedirect } from '../src/lib/canonical-host';

const req = (url: string, init?: RequestInit) => new Request(url, init);

describe('canonicalHostRedirect', () => {
  it('www를 apex로 301 보낸다 — 원본 카페24가 하던 동작 그대로다', () => {
    const res = canonicalHostRedirect(req('https://www.dlas.co.kr/'));
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://dlas.co.kr/');
  });

  it('경로와 쿼리를 잃지 않는다', () => {
    const res = canonicalHostRedirect(
      req('https://www.dlas.co.kr/consulting-new-car/?utm_source=naver&a=1'),
    );
    expect(res?.headers.get('location')).toBe(
      'https://dlas.co.kr/consulting-new-car/?utm_source=naver&a=1',
    );
  });

  it('http로 와도 https apex로 보낸다', () => {
    const res = canonicalHostRedirect(req('http://www.dlas.co.kr/about/'));
    expect(res?.headers.get('location')).toBe('https://dlas.co.kr/about/');
  });

  it('apex는 건드리지 않는다', () => {
    expect(canonicalHostRedirect(req('https://dlas.co.kr/'))).toBeNull();
  });

  it('workers.dev는 건드리지 않는다 — 전환 롤백 경로라 살아 있어야 한다', () => {
    expect(canonicalHostRedirect(req('https://dlas.dolcejian.workers.dev/'))).toBeNull();
  });

  it('로컬 개발 주소는 건드리지 않는다', () => {
    expect(canonicalHostRedirect(req('http://localhost:8787/'))).toBeNull();
    expect(canonicalHostRedirect(req('http://127.0.0.1:4321/analysis/'))).toBeNull();
  });

  it('호스트 대문자·포트 표기에도 걸린다', () => {
    const res = canonicalHostRedirect(req('https://WWW.DLAS.CO.KR/'));
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://dlas.co.kr/');
  });

  it('POST는 절대 넘기지 않는다 — 2026-08-16에 이걸로 폼이 통째로 죽었다', () => {
    // 308로 넘겼더니 교차 출처 리다이렉트가 되어, apex가 CORS 헤더를 주지 않아
    // fetch가 실패했다. CF7은 성공도 실패도 아닌 채로 스피너만 돌렸다.
    // 301도 답이 아니다 — 본문 없는 GET이 되어 문의가 조용히 사라진다.
    const res = canonicalHostRedirect(
      req('https://www.dlas.co.kr/wp-json/contact-form-7/v1/contact-forms/583/feedback', {
        method: 'POST',
      }),
    );
    expect(res).toBeNull();
  });

  it('PUT·DELETE 등 다른 메서드도 넘기지 않는다', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(canonicalHostRedirect(req('https://www.dlas.co.kr/x', { method }))).toBeNull();
    }
  });

  it('HEAD는 GET과 같이 301로 넘긴다', () => {
    const res = canonicalHostRedirect(req('https://www.dlas.co.kr/about/', { method: 'HEAD' }));
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://dlas.co.kr/about/');
  });
});
