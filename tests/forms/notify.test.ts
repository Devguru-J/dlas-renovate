import { describe, it, expect } from 'vitest';
import { buildEmail, escapeHtml, sendEmail } from '../../src/lib/forms/notify';
import type { SubmissionRow } from '../../src/lib/forms/db';

function row(over: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: 'sub-1',
    form_key: 'consulting-new-car',
    form_subject: '신차 상담신청',
    name: '홍길동',
    phone: '010-1234-5678',
    car: 'BMW 520i',
    methods: ['운용리스', '할부'],
    pay_period: ['이번 달'],
    message: '견적 부탁드립니다',
    ref: 'naver',
    referer_page: '/lease/',
    source_page: 'https://dlas.co.kr/consulting-new-car/',
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: 'h',
    user_agent: 'ua',
    ...over,
  };
}

describe('escapeHtml', () => {
  it('HTML 특수문자를 이스케이프한다', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
});

describe('buildEmail', () => {
  it('제목에 폼 이름과 신청자를 넣는다', () => {
    const { subject } = buildEmail(row(), []);
    expect(subject).toBe('[신차 상담신청] 홍길동 010-1234-5678');
  });

  it('체크박스는 쉼표로 이어 붙인다', () => {
    const { html } = buildEmail(row(), []);
    expect(html).toContain('운용리스, 할부');
    expect(html).toContain('이번 달');
  });

  it('첨부 링크를 넣고 만료를 안내한다', () => {
    const { html } = buildEmail(row({ form_key: 'analysis', form_subject: '견적서 비교분석' }), [
      { filename: '견적서.pdf', url: 'https://dlas.co.kr/api/file/sub-1/1?t=abc' },
    ]);
    expect(html).toContain('https://dlas.co.kr/api/file/sub-1/1?t=abc');
    expect(html).toContain('견적서.pdf');
    expect(html).toContain('7일');
  });

  it('첨부가 없으면 첨부 항목을 넣지 않는다', () => {
    const { html } = buildEmail(row(), []);
    expect(html).not.toContain('첨부파일');
  });

  it('사용자 입력을 이스케이프한다', () => {
    const { html } = buildEmail(row({ name: '<img src=x onerror=alert(1)>' }), []);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('빈 필드는 표에서 생략한다', () => {
    const { html } = buildEmail(row({ car: null, message: null, methods: [], pay_period: [] }), []);
    expect(html).not.toContain('차종');
    expect(html).not.toContain('문의사항');
  });
});

describe('sendEmail', () => {
  it('Resend API로 보낸다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response('{"id":"x"}', { status: 200 });
    };

    await sendEmail(
      { apiKey: 'key', from: 'noreply@dlas.co.kr', to: ['a@dlas.co.kr', 'b@dlas.co.kr'] },
      '제목',
      '<p>본문</p>',
      fake,
    );

    expect(seen!.url).toBe('https://api.resend.com/emails');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(seen!.init.body as string);
    expect(body.to).toEqual(['a@dlas.co.kr', 'b@dlas.co.kr']);
    expect(body.subject).toBe('제목');
  });

  it('실패하면 에러를 던진다', async () => {
    const fake: typeof fetch = async () => new Response('bad key', { status: 401 });
    await expect(
      sendEmail({ apiKey: 'k', from: 'f@x.com', to: ['t@x.com'] }, 's', 'h', fake),
    ).rejects.toThrow(/401.*bad key/);
  });
});
