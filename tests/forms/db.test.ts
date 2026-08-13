import { describe, it, expect } from 'vitest';
import {
  insertSubmission,
  updateEmailStatus,
  fetchAttachments,
  type SubmissionRow,
} from '../../src/lib/forms/db';

const CFG = { url: 'https://proj.supabase.co', serviceRoleKey: 'service-key' };

function row(): SubmissionRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    form_key: 'analysis',
    form_subject: '견적서 비교분석',
    name: '홍길동',
    phone: '010-1234-5678',
    car: null,
    methods: [],
    pay_period: [],
    message: null,
    ref: null,
    referer_page: null,
    source_page: 'https://dlas.co.kr/analysis/',
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: 'abc',
    user_agent: 'test-agent',
  };
}

describe('insertSubmission', () => {
  it('PostgREST 엔드포인트로 service role 키를 실어 POST한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response('', { status: 201 });
    };

    await insertSubmission(CFG, row(), fake);

    expect(seen!.url).toBe('https://proj.supabase.co/rest/v1/contact_submissions');
    expect(seen!.init.method).toBe('POST');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('service-key');
    expect(headers.Authorization).toBe('Bearer service-key');
    expect(headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(seen!.init.body as string).name).toBe('홍길동');
  });

  it('실패 응답이면 상태코드와 code만 담은 에러를 던진다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: '23505', message: 'duplicate key value' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });

    await expect(insertSubmission(CFG, row(), fake)).rejects.toThrow(/status=409.*code=23505/);
    await expect(insertSubmission(CFG, row(), fake)).rejects.not.toThrow(/duplicate key value/);
  });

  it('PostgREST 오류 본문의 고객 PII를 에러 메시지에 넣지 않는다', async () => {
    const body = {
      code: '23514',
      message: 'new row for relation "contact_submissions" violates check constraint',
      details: 'Failing row contains (홍길동, 010-1234-5678, …).',
      hint: '제약조건을 확인하세요.',
    };
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    const err = await insertSubmission(CFG, row(), fake).catch((e: unknown) => e as Error);
    const text = String((err as Error).message);
    expect(text).toContain('status=400');
    expect(text).toContain('code=23514');
    expect(text).toContain('hint=제약조건을 확인하세요.');
    expect(text).not.toContain('홍길동');
    expect(text).not.toContain('010-1234-5678');
    expect(text).not.toContain('Failing row contains');
    expect(text).not.toContain('violates check constraint');
  });

  it('본문이 JSON이 아니면 상태코드만 남긴다', async () => {
    const fake: typeof fetch = async () =>
      new Response('<html>홍길동 010-1234-5678</html>', { status: 502 });

    const err = await insertSubmission(CFG, row(), fake).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('supabase insert failed: status=502');
  });

  it('URL 끝의 슬래시를 중복시키지 않는다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response('', { status: 201 });
    };
    await insertSubmission({ ...CFG, url: 'https://proj.supabase.co/' }, row(), fake);
    expect(seen).toBe('https://proj.supabase.co/rest/v1/contact_submissions');
  });

  it('fetch 자체가 reject하면 그대로 던진다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    await expect(insertSubmission(CFG, row(), fake)).rejects.toThrow('network down');
  });
});

describe('updateEmailStatus', () => {
  it('id로 좁혀 PATCH한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(null, { status: 204 });
    };

    await updateEmailStatus(CFG, 'sub-1', { email_sent_at: '2026-08-12T00:00:00Z', email_error: null }, fake);

    expect(seen!.url).toBe('https://proj.supabase.co/rest/v1/contact_submissions?id=eq.sub-1');
    expect(seen!.init.method).toBe('PATCH');
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      email_sent_at: '2026-08-12T00:00:00Z',
      email_error: null,
    });
  });

  it('실패해도 던지지 않는다', async () => {
    const fake: typeof fetch = async () => new Response('nope', { status: 500 });
    await expect(
      updateEmailStatus(CFG, 'sub-1', { email_sent_at: null, email_error: 'x' }, fake),
    ).resolves.toBeUndefined();
  });

  it('fetch가 reject해도 던지지 않는다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    await expect(
      updateEmailStatus(CFG, 'sub-1', { email_sent_at: null, email_error: 'x' }, fake),
    ).resolves.toBeUndefined();
  });
});

describe('fetchAttachments', () => {
  it('id로 좁혀 attachments만 조회한다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response(
        JSON.stringify([
          {
            attachments: [
              { n: 1, filename: 'a.pdf', size: 1, content_type: 'application/pdf', r2_key: 'k' },
            ],
          },
        ]),
        { status: 200 },
      );
    };
    const out = await fetchAttachments(CFG, 'sub-1', fake);
    expect(seen).toContain('id=eq.sub-1');
    expect(seen).toContain('select=attachments');
    expect(out[0].r2_key).toBe('k');
  });

  it('레코드가 없으면 빈 배열이다', async () => {
    const fake: typeof fetch = async () => new Response('[]', { status: 200 });
    expect(await fetchAttachments(CFG, 'none', fake)).toEqual([]);
  });

  it('실패 응답이면 본문 없이 상태코드만 담은 에러를 던진다', async () => {
    const fake: typeof fetch = async () => new Response('boom', { status: 500 });
    const err = await fetchAttachments(CFG, 'sub-1', fake).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('supabase select failed: status=500');
  });

  it('실패 응답의 PostgREST 본문을 에러 메시지에 넣지 않는다', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({ code: '42P01', message: 'relation does not exist', details: '홍길동' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    const err = await fetchAttachments(CFG, 'sub-1', fake).catch((e: unknown) => e as Error);
    const text = (err as Error).message;
    expect(text).toContain('status=404');
    expect(text).toContain('code=42P01');
    expect(text).not.toContain('홍길동');
    expect(text).not.toContain('relation does not exist');
  });
});
