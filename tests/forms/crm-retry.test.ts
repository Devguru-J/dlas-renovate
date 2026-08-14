import { describe, it, expect } from 'vitest';
import { runCrmRetry, syncLeadNow, type CrmRetryBucket } from '../../src/lib/forms/crm-retry';
import { CRM_MAX_ATTEMPTS, type PendingCrmLead } from '../../src/lib/forms/db';

const SUPABASE = { url: 'https://proj.supabase.co', serviceRoleKey: 'service-key' };
const CRM = { endpoint: 'https://crm.mrcha.app/api/homepage/lead', secret: 'sh-secret' };
const MAIL = { apiKey: 'resend-key', from: 'a@b.c', to: ['staff@dlas.co.kr'] };

function lead(over: Partial<PendingCrmLead> = {}): PendingCrmLead {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    form_key: 'consulting-new-car',
    form_subject: '신차 상담신청',
    name: '홍길동',
    phone: '010-1234-5678',
    car: 'BMW 520i',
    methods: ['운용리스'],
    pay_period: ['이번 달'],
    message: '견적 부탁드립니다',
    ref: null,
    referer_page: null,
    source_page: null,
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: null,
    user_agent: null,
    crm_attempts: 0,
    ...over,
  };
}

interface Recorded {
  patches: { id: string; body: Record<string, unknown> }[];
  crmCalls: FormData[];
  mails: { subject: string; html: string }[];
  r2Reads: string[];
}

/**
 * Supabase·CRM·Resend를 한 fetch에서 URL로 갈라 응답한다.
 * 실제 코드가 어디로 무엇을 보냈는지만 기록하고, 목 객체의 동작이 아니라
 * 그 기록(= 관찰 가능한 결과)에 대해 단언한다.
 */
function harness(opts: {
  rows: PendingCrmLead[];
  crm: (form: FormData) => Response | Promise<Response>;
  r2?: Record<string, string>;
  mailFails?: boolean;
}) {
  const rec: Recorded = { patches: [], crmCalls: [], mails: [], r2Reads: [] };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith(SUPABASE.url) && method === 'GET') {
      return new Response(JSON.stringify(opts.rows), { status: 200 });
    }
    if (url.startsWith(SUPABASE.url) && method === 'PATCH') {
      const id = new URL(url).searchParams.get('id')?.replace('eq.', '') ?? '';
      rec.patches.push({ id, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 204 });
    }
    if (url === CRM.endpoint) {
      const body = init?.body as FormData;
      rec.crmCalls.push(body);
      return await opts.crm(body);
    }
    if (url.startsWith('https://api.resend.com')) {
      if (opts.mailFails) return new Response('nope', { status: 500 });
      const sent = JSON.parse(String(init?.body)) as { subject: string; html: string };
      rec.mails.push(sent);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`예상하지 못한 요청: ${method} ${url}`);
  };

  const bucket: CrmRetryBucket = {
    async get(key: string) {
      rec.r2Reads.push(key);
      const content = opts.r2?.[key];
      if (content === undefined) return null;
      return { arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer };
    },
  };

  return { rec, deps: { supabase: SUPABASE, crm: CRM, mail: MAIL, bucket, fetchImpl } };
}

const ok201 = () => new Response(JSON.stringify({ customerId: 'cus_1' }), { status: 201 });

describe('runCrmRetry', () => {
  it('전송에 성공하면 동기 시각과 CRM 레코드 ID를 기록한다', async () => {
    const { rec, deps } = harness({ rows: [lead()], crm: ok201 });

    const summary = await runCrmRetry(deps);

    expect(summary.synced).toBe(1);
    const patch = rec.patches[0].body;
    expect(typeof patch.crm_synced_at).toBe('string');
    expect(patch.crm_record_id).toBe('cus_1');
    expect(patch.crm_error).toBeNull();
  });

  it('성공해도 시도 횟수는 올린다', async () => {
    const { rec, deps } = harness({ rows: [lead({ crm_attempts: 2 })], crm: ok201 });

    await runCrmRetry(deps);

    expect(rec.patches[0].body.crm_attempts).toBe(3);
  });

  it('같은 리드를 다시 보내 200 duplicate를 받아도 성공으로 기록한다', async () => {
    const { rec, deps } = harness({
      rows: [lead()],
      crm: () => new Response(JSON.stringify({ duplicate: true, customerId: 'cus_1' }), { status: 200 }),
    });

    const summary = await runCrmRetry(deps);

    expect(summary.synced).toBe(1);
    expect(typeof rec.patches[0].body.crm_synced_at).toBe('string');
  });

  it('재시도 가능한 실패는 동기 시각을 건드리지 않고 사유만 남긴다', async () => {
    const { rec, deps } = harness({ rows: [lead()], crm: () => new Response('', { status: 503 }) });

    const summary = await runCrmRetry(deps);

    expect(summary.failed).toBe(1);
    expect(rec.patches[0].body).not.toHaveProperty('crm_synced_at');
    expect(rec.patches[0].body.crm_error).toContain('status=503');
    expect(rec.patches[0].body.crm_attempts).toBe(1);
  });

  it('재시도 가능한 실패만으로는 담당자를 부르지 않는다', async () => {
    const { rec, deps } = harness({ rows: [lead()], crm: () => new Response('', { status: 503 }) });

    await runCrmRetry(deps);

    expect(rec.mails).toHaveLength(0);
  });

  it('재시도해도 소용없는 실패는 시도 횟수를 상한까지 올려 다시 집히지 않게 한다', async () => {
    const { rec, deps } = harness({
      rows: [lead({ crm_attempts: 1 })],
      crm: () => new Response(JSON.stringify({ code: 'bad_request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await runCrmRetry(deps);

    expect(rec.patches[0].body.crm_attempts).toBe(CRM_MAX_ATTEMPTS);
  });

  it('재시도해도 소용없는 실패는 즉시 담당자에게 알린다', async () => {
    const { rec, deps } = harness({
      rows: [lead()],
      crm: () => new Response('', { status: 401 }),
    });

    const summary = await runCrmRetry(deps);

    expect(summary.alerted).toBe(1);
    expect(rec.mails[0].subject).toContain('[CRM전송실패]');
    expect(rec.mails[0].html).toContain('status=401');
  });

  it('마지막 재시도까지 실패하면 담당자에게 알린다', async () => {
    const { rec, deps } = harness({
      rows: [lead({ crm_attempts: CRM_MAX_ATTEMPTS - 1 })],
      crm: () => new Response('', { status: 503 }),
    });

    await runCrmRetry(deps);

    expect(rec.mails).toHaveLength(1);
  });

  it('상한에 닿기 전 재시도 가능한 실패에는 알리지 않는다', async () => {
    const { rec, deps } = harness({
      rows: [lead({ crm_attempts: CRM_MAX_ATTEMPTS - 2 })],
      crm: () => new Response('', { status: 503 }),
    });

    await runCrmRetry(deps);

    expect(rec.mails).toHaveLength(0);
  });

  it('알림 발송이 실패해도 전송 결과 기록은 남는다', async () => {
    const { rec, deps } = harness({
      rows: [lead()],
      crm: () => new Response('', { status: 401 }),
      mailFails: true,
    });

    await runCrmRetry(deps);

    expect(rec.patches).toHaveLength(1);
    expect(rec.patches[0].body.crm_error).toContain('status=401');
  });

  it('견적 폼은 R2에서 첨부를 읽어 파일 필드에 싣는다', async () => {
    const { rec, deps } = harness({
      rows: [
        lead({
          form_key: 'analysis',
          attachments: [
            { n: 1, filename: '견적서.pdf', size: 3, content_type: 'application/pdf', r2_key: 'k/1.pdf' },
          ],
        }),
      ],
      crm: ok201,
      r2: { 'k/1.pdf': 'PDF' },
    });

    await runCrmRetry(deps);

    expect(rec.r2Reads).toEqual(['k/1.pdf']);
    const file = rec.crmCalls[0].get('file1');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('견적서.pdf');
  });

  it('상담 폼은 R2를 읽지 않는다', async () => {
    const { rec, deps } = harness({ rows: [lead()], crm: ok201 });

    await runCrmRetry(deps);

    expect(rec.r2Reads).toHaveLength(0);
  });

  it('첨부가 R2에서 사라졌으면 반쪽짜리로 보내지 않고 담당자를 부른다', async () => {
    const { rec, deps } = harness({
      rows: [
        lead({
          form_key: 'analysis',
          attachments: [
            { n: 1, filename: 'a.pdf', size: 3, content_type: 'application/pdf', r2_key: 'gone.pdf' },
          ],
        }),
      ],
      crm: ok201,
      r2: {},
    });

    await runCrmRetry(deps);

    expect(rec.crmCalls).toHaveLength(0);
    expect(rec.patches[0].body.crm_attempts).toBe(CRM_MAX_ATTEMPTS);
    expect(rec.mails).toHaveLength(1);
  });

  it('한 건이 실패해도 나머지 건을 계속 처리한다', async () => {
    let call = 0;
    const { rec, deps } = harness({
      rows: [lead({ id: 'a' }), lead({ id: 'b' })],
      crm: () => {
        call += 1;
        if (call === 1) throw new Error('네트워크 끊김');
        return ok201();
      },
    });

    const summary = await runCrmRetry(deps);

    expect(summary.picked).toBe(2);
    expect(summary.synced).toBe(1);
    expect(rec.patches.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('보낼 리드가 없으면 CRM을 부르지 않는다', async () => {
    const { rec, deps } = harness({ rows: [], crm: ok201 });

    const summary = await runCrmRetry(deps);

    expect(summary.picked).toBe(0);
    expect(rec.crmCalls).toHaveLength(0);
  });
});

describe('syncLeadNow', () => {
  it('CRM 대상이 아닌 폼은 전송도 기록도 하지 않는다', async () => {
    const { rec, deps } = harness({ rows: [], crm: ok201 });

    await syncLeadNow(deps, lead({ form_key: 'consulting-detailing' }), []);

    expect(rec.crmCalls).toHaveLength(0);
    expect(rec.patches).toHaveLength(0);
  });

  it('성공하면 동기 시각과 레코드 ID를 기록한다', async () => {
    const { rec, deps } = harness({ rows: [], crm: ok201 });

    await syncLeadNow(deps, lead(), []);

    expect(typeof rec.patches[0].body.crm_synced_at).toBe('string');
    expect(rec.patches[0].body.crm_record_id).toBe('cus_1');
    expect(rec.patches[0].body.crm_attempts).toBe(1);
  });

  it('넘겨받은 첨부를 그대로 싣고 R2는 건드리지 않는다', async () => {
    const { rec, deps } = harness({ rows: [], crm: ok201 });

    await syncLeadNow(deps, lead({ form_key: 'analysis' }), [
      {
        n: 1,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        body: new TextEncoder().encode('PDF').buffer as ArrayBuffer,
      },
    ]);

    expect(rec.r2Reads).toHaveLength(0);
    expect(rec.crmCalls[0].get('file1')).toBeInstanceOf(File);
  });

  it('재시도 가능한 실패는 사유만 남기고 담당자를 부르지 않는다', async () => {
    const { rec, deps } = harness({ rows: [], crm: () => new Response('', { status: 404 }) });

    await syncLeadNow(deps, lead(), []);

    expect(rec.patches[0].body.crm_error).toContain('status=404');
    expect(rec.patches[0].body.crm_attempts).toBe(1);
    expect(rec.mails).toHaveLength(0);
  });

  it('재시도해도 소용없는 실패는 크론에 넘기지 않고 바로 알린다', async () => {
    const { rec, deps } = harness({ rows: [], crm: () => new Response('', { status: 401 }) });

    await syncLeadNow(deps, lead(), []);

    expect(rec.patches[0].body.crm_attempts).toBe(CRM_MAX_ATTEMPTS);
    expect(rec.mails).toHaveLength(1);
  });

  it('전송이 어떻게 실패하든 던지지 않는다 — 제출은 이미 성공했다', async () => {
    const { deps } = harness({
      rows: [],
      crm: () => {
        throw new Error('네트워크 끊김');
      },
    });

    await expect(syncLeadNow(deps, lead(), [])).resolves.toBeUndefined();
  });
});
