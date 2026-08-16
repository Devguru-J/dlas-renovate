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

  it('POST는 301이 아니라 308로 보낸다 — 301은 메서드를 GET으로 바꿔 제출을 삼킨다', () => {
    // 폼 action이 상대경로라 www에서 폼을 열면 제출도 www로 간다. 실제로는 페이지
    // 로드 시점에 이미 apex로 넘어가므로 이 경로를 탈 일이 거의 없지만, 타면
    // 301은 본문 없는 GET으로 바꿔 버려 문의가 조용히 사라진다. 308은 보존한다.
    const res = canonicalHostRedirect(
      req('https://www.dlas.co.kr/wp-json/contact-form-7/v1/contact-forms/583/feedback', {
        method: 'POST',
      }),
    );
    expect(res?.status).toBe(308);
    expect(res?.headers.get('location')).toBe(
      'https://dlas.co.kr/wp-json/contact-form-7/v1/contact-forms/583/feedback',
    );
  });
});
