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

  it('실패 응답이면 본문을 포함한 에러를 던진다', async () => {
    const fake: typeof fetch = async () =>
      new Response('duplicate key value', { status: 409 });

    await expect(insertSubmission(CFG, row(), fake)).rejects.toThrow(
      /409.*duplicate key value/,
    );
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

  it('실패 응답이면 에러를 던진다', async () => {
    const fake: typeof fetch = async () => new Response('boom', { status: 500 });
    await expect(fetchAttachments(CFG, 'sub-1', fake)).rejects.toThrow(/500.*boom/);
  });
});
