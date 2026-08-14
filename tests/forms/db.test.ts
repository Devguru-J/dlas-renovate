import { describe, it, expect } from 'vitest';
import {
  insertSubmission,
  updateEmailStatus,
  updateCrmStatus,
  fetchPendingCrmLeads,
  fetchAttachments,
  CRM_MAX_ATTEMPTS,
  CRM_RETRY_SPACING_MS,
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
    dedupe_key: 'deadbeef',
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
      new Response(JSON.stringify({ code: '23503', message: 'insert violates foreign key' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });

    await expect(insertSubmission(CFG, row(), fake)).rejects.toThrow(/status=409.*code=23503/);
    await expect(insertSubmission(CFG, row(), fake)).rejects.not.toThrow(/foreign key/);
  });

  it('성공하면 inserted를 돌려준다', async () => {
    const fake: typeof fetch = async () => new Response('', { status: 201 });
    expect(await insertSubmission(CFG, row(), fake)).toBe('inserted');
  });

  it('dedupe_key 중복(23505)은 실패가 아니라 duplicate로 돌려준다', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          code: '23505',
          message: 'duplicate key value violates unique constraint',
          details: 'Key (dedupe_key)=(abc) already exists.',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );

    expect(await insertSubmission(CFG, row(), fake)).toBe('duplicate');
  });

  it('dedupe_key 컬럼이 아직 없으면(PGRST204) 그 필드를 빼고 다시 넣는다', async () => {
    const bodies: string[] = [];
    const fake: typeof fetch = async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ code: 'PGRST204', message: "Could not find the 'dedupe_key' column" }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 201 });
    };

    expect(await insertSubmission(CFG, row(), fake)).toBe('inserted');
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0])).toHaveProperty('dedupe_key');
    expect(JSON.parse(bodies[1])).not.toHaveProperty('dedupe_key');
    // 문의 자체는 저장돼야 한다
    expect(JSON.parse(bodies[1]).name).toBe('홍길동');
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

describe('updateCrmStatus', () => {
  it('성공 결과를 id로 좁혀 PATCH한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(null, { status: 204 });
    };

    await updateCrmStatus(
      CFG,
      'sub-1',
      {
        crm_synced_at: '2026-08-13T00:00:00Z',
        crm_record_id: 'c-1',
        crm_error: null,
        crm_attempts: 1,
        crm_last_attempt_at: '2026-08-13T00:00:00Z',
      },
      fake,
    );

    expect(seen!.url).toBe('https://proj.supabase.co/rest/v1/contact_submissions?id=eq.sub-1');
    expect(seen!.init.method).toBe('PATCH');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('service-key');
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      crm_synced_at: '2026-08-13T00:00:00Z',
      crm_record_id: 'c-1',
      crm_error: null,
      crm_attempts: 1,
      crm_last_attempt_at: '2026-08-13T00:00:00Z',
    });
  });

  it('실패 결과는 crm_synced_at을 건드리지 않고 보낼 수 있다', async () => {
    let body = '';
    const fake: typeof fetch = async (_url, init) => {
      body = (init as RequestInit).body as string;
      return new Response(null, { status: 204 });
    };
    await updateCrmStatus(
      CFG,
      'sub-1',
      { crm_error: 'status=503', crm_attempts: 3, crm_last_attempt_at: '2026-08-13T00:00:00Z' },
      fake,
    );
    expect(Object.keys(JSON.parse(body))).toEqual([
      'crm_error',
      'crm_attempts',
      'crm_last_attempt_at',
    ]);
  });

  it('실패 응답이어도 던지지 않는다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: '42703', details: '홍길동' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      updateCrmStatus(
        CFG,
        'sub-1',
        { crm_error: 'x', crm_attempts: 1, crm_last_attempt_at: 'now' },
        fake,
      ),
    ).resolves.toBeUndefined();
  });

  it('fetch가 reject해도 던지지 않는다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    await expect(
      updateCrmStatus(
        CFG,
        'sub-1',
        { crm_error: 'x', crm_attempts: 1, crm_last_attempt_at: 'now' },
        fake,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('fetchPendingCrmLeads', () => {
  it('미동기·CRM 대상 폼·시도 상한 미만을 오래된 순으로 조회한다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response('[]', { status: 200 });
    };

    await fetchPendingCrmLeads(CFG, 20, fake);

    const q = new URL(seen).searchParams;
    expect(seen.startsWith('https://proj.supabase.co/rest/v1/contact_submissions?')).toBe(true);
    expect(q.get('crm_synced_at')).toBe('is.null');
    expect(q.get('form_key')).toBe('in.(analysis,consulting-new-car)');
    expect(q.get('crm_attempts')).toBe(`lt.${CRM_MAX_ATTEMPTS}`);
    expect(q.get('order')).toBe('created_at.asc');
    expect(q.get('limit')).toBe('20');
    expect(q.get('select')).toContain('form_key');
    expect(q.get('select')).toContain('attachments');
  });

  it('한 번도 시도 안 했거나 마지막 시도가 간격보다 오래된 행만 집는다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response('[]', { status: 200 });
    };
    const now = new Date('2026-08-13T12:00:00.000Z');

    await fetchPendingCrmLeads(CFG, 20, fake, now);

    const cutoff = new Date(now.getTime() - CRM_RETRY_SPACING_MS).toISOString();
    expect(new URL(seen).searchParams.get('or')).toBe(
      `(crm_last_attempt_at.is.null,crm_last_attempt_at.lt.${cutoff})`,
    );
    // 재시도 창(간격 × 상한)이 크론 주기와 무관하게 최소 4시간은 되어야 한다.
    expect(CRM_RETRY_SPACING_MS * CRM_MAX_ATTEMPTS).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000);
  });

  it('행을 그대로 돌려준다', async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify([row()]), { status: 200 });
    const rows = await fetchPendingCrmLeads(CFG, 5, fake);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('11111111-2222-3333-4444-555555555555');
  });

  // 크론은 updateCrmStatus에 crm_attempts를 "현재값 + 1"로 써야 하는데,
  // 현재값을 이 조회 말고는 알 방법이 없다. select에서 빠지면 크론이 카운터를
  // 매번 1로 덮어써 상한이 영영 오지 않는다.
  it('crm_attempts를 함께 조회해 돌려준다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response(JSON.stringify([{ ...row(), crm_attempts: 3 }]), { status: 200 });
    };

    const rows = await fetchPendingCrmLeads(CFG, 5, fake);

    expect(new URL(seen).searchParams.get('select')).toContain('crm_attempts');
    expect(rows[0].crm_attempts).toBe(3);
  });

  it('실패 응답이면 본문 없이 상태코드만 담은 에러를 던진다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: '42703', details: 'Failing row contains (홍길동)' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const err = await fetchPendingCrmLeads(CFG, 5, fake).catch((e: unknown) => e as Error);
    const text = (err as Error).message;
    expect(text).toContain('status=400');
    expect(text).toContain('code=42703');
    expect(text).not.toContain('홍길동');
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
