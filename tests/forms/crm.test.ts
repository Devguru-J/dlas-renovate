import { describe, it, expect } from 'vitest';
import {
  crmTypeFor,
  buildCrmForm,
  pushLead,
  CRM_FORM_KEYS,
  type CrmAttachment,
  type CrmConfig,
} from '../../src/lib/forms/crm';
import type { SubmissionRow } from '../../src/lib/forms/db';

const CFG: CrmConfig = { endpoint: 'https://crm.example/api/homepage/lead', secret: 'sh-secret-42' };

function row(over: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    form_key: 'consulting-new-car',
    form_subject: '신차 상담신청',
    name: '홍길동',
    phone: '010-1234-5678',
    car: 'BMW 520i 검정',
    methods: ['운용리스'],
    pay_period: ['이번 달'],
    message: '오전에 연락 주세요',
    ref: null,
    referer_page: null,
    source_page: 'https://dlas.co.kr/consulting/',
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: null,
    user_agent: null,
    ...over,
  };
}

function attachment(n: number, filename: string): CrmAttachment {
  return {
    n,
    filename,
    contentType: 'application/pdf',
    body: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
  };
}

describe('crmTypeFor', () => {
  it('analysis는 quote다', () => {
    expect(crmTypeFor('analysis')).toBe('quote');
  });
  it('consulting-new-car는 consult다', () => {
    expect(crmTypeFor('consulting-new-car')).toBe('consult');
  });
  it('consulting-used-car는 CRM 대상이 아니다', () => {
    expect(crmTypeFor('consulting-used-car')).toBeNull();
  });
  it('consulting-detailing은 CRM 대상이 아니다', () => {
    expect(crmTypeFor('consulting-detailing')).toBeNull();
  });
  it('CRM_FORM_KEYS는 대상 두 개뿐이다', () => {
    expect([...CRM_FORM_KEYS].sort()).toEqual(['analysis', 'consulting-new-car']);
  });
});

describe('buildCrmForm', () => {
  it('consult 필드를 계약대로 매핑한다', () => {
    const f = buildCrmForm(row(), []);
    expect(f.get('type')).toBe('consult');
    expect(f.get('submissionId')).toBe('11111111-2222-3333-4444-555555555555');
    expect(f.get('name')).toBe('홍길동');
    expect(f.get('phone')).toBe('010-1234-5678');
    expect(f.get('desiredModel')).toBe('BMW 520i 검정');
    expect(f.get('inquiry')).toBe('오전에 연락 주세요');
  });

  it('submissionId에 접두사를 붙이지 않는다', () => {
    const f = buildCrmForm(row({ id: 'abc-123' }), []);
    expect(f.get('submissionId')).toBe('abc-123');
  });

  it('methods/pay_period의 첫 원소 하나만 단일 값으로 보낸다', () => {
    const f = buildCrmForm(row({ methods: ['장기렌트', '할부'], pay_period: ['다음 달'] }), []);
    expect(f.getAll('purchaseMethod')).toEqual(['장기렌트']);
    expect(f.get('purchaseTiming')).toBe('다음 달');
  });

  it('배열이 비면 필드 자체를 넣지 않는다', () => {
    const f = buildCrmForm(row({ methods: [], pay_period: [] }), []);
    expect(f.has('purchaseMethod')).toBe(false);
    expect(f.has('purchaseTiming')).toBe(false);
  });

  it('빈 선택 필드는 생략한다', () => {
    const f = buildCrmForm(row({ message: null, car: '   ' }), []);
    expect(f.has('inquiry')).toBe(false);
    expect(f.has('desiredModel')).toBe(false);
  });

  it('quote는 첨부를 file1·file2로 싣는다', () => {
    const f = buildCrmForm(row({ form_key: 'analysis', form_subject: '견적서 비교분석' }), [
      attachment(1, 'a.pdf'),
      attachment(2, 'b.pdf'),
    ]);
    expect(f.get('type')).toBe('quote');
    expect((f.get('file1') as File).name).toBe('a.pdf');
    expect((f.get('file2') as File).name).toBe('b.pdf');
    expect((f.get('file1') as File).type).toBe('application/pdf');
  });

  it('quote는 첨부를 2개까지만 싣는다', () => {
    const f = buildCrmForm(row({ form_key: 'analysis' }), [
      attachment(1, 'a.pdf'),
      attachment(2, 'b.pdf'),
      attachment(3, 'c.pdf'),
    ]);
    expect(f.has('file2')).toBe(true);
    expect(f.has('file3')).toBe(false);
  });

  it('consult에는 첨부를 넣지 않는다', () => {
    const f = buildCrmForm(row(), [attachment(1, 'a.pdf')]);
    expect(f.has('file1')).toBe(false);
  });

  it('quote에는 consult 전용 필드를 넣지 않는다', () => {
    const f = buildCrmForm(row({ form_key: 'analysis' }), []);
    expect(f.has('desiredModel')).toBe(false);
    expect(f.has('purchaseMethod')).toBe(false);
    expect(f.has('purchaseTiming')).toBe(false);
  });

  it('CRM 대상이 아닌 폼이면 던진다', () => {
    expect(() => buildCrmForm(row({ form_key: 'consulting-detailing' }), [])).toThrow(
      /consulting-detailing/,
    );
  });
});

function respond(status: number, body = '', headers: Record<string, string> = {}): typeof fetch {
  return async () => new Response(body === '' ? null : body, { status, headers });
}

const JSON_H = { 'content-type': 'application/json' };

describe('pushLead 응답 분류', () => {
  it('시크릿을 헤더로 실어 POST한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(null, { status: 201 });
    };
    await pushLead(CFG, new FormData(), fake);
    expect(seen!.url).toBe('https://crm.example/api/homepage/lead');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>)['x-homepage-secret']).toBe('sh-secret-42');
  });

  it('201은 성공이고 중복이 아니다', async () => {
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(201, JSON.stringify({ customerId: 'c-1', customerCode: 'DL-0001' }), JSON_H),
    );
    expect(out).toEqual({ ok: true, duplicate: false, customerId: 'c-1', customerCode: 'DL-0001' });
  });

  it('200은 성공이고 중복이다', async () => {
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(200, JSON.stringify({ duplicate: true, customerId: 'c-1', customerCode: 'DL-0001' }), JSON_H),
    );
    expect(out).toEqual({ ok: true, duplicate: true, customerId: 'c-1', customerCode: 'DL-0001' });
  });

  it('본문이 JSON이 아니어도 상태코드로 성공 판정한다', async () => {
    const out = await pushLead(CFG, new FormData(), respond(201, 'OK'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.customerId).toBeNull();
      expect(out.customerCode).toBeNull();
    }
  });

  it('503은 재시도 대상 실패다', async () => {
    const out = await pushLead(CFG, new FormData(), respond(503, 'not configured'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.retryable).toBe(true);
      expect(out.reason).toContain('status=503');
    }
  });

  it('503이 아닌 5xx도 재시도 대상이다', async () => {
    for (const status of [500, 502, 504]) {
      const out = await pushLead(CFG, new FormData(), respond(status, 'boom'));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(status);
        expect(out.retryable).toBe(true);
      }
    }
  });

  it('400·401·413·415는 재시도 대상이 아니다', async () => {
    for (const status of [400, 401, 413, 415]) {
      const out = await pushLead(CFG, new FormData(), respond(status, 'nope'));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(status);
        expect(out.retryable).toBe(false);
      }
    }
  });

  it('그 밖의 4xx도 재시도 대상이 아니다', async () => {
    for (const status of [409, 418, 422]) {
      const out = await pushLead(CFG, new FormData(), respond(status, 'nope'));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(status);
        expect(out.retryable).toBe(false);
      }
    }
  });

  it('404는 4xx지만 재시도 대상이다', async () => {
    // 상대측 라우트 미배포 상태가 404로 온다(2026-08-13 확인). 배포 전에 들어온 리드가
    // 영구 실패로 찍혀 버리면 엔드포인트가 살아나도 영영 집히지 않는다.
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(404, JSON.stringify({ error: 'Not found' }), JSON_H),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      expect(out.retryable).toBe(true);
      expect(out.reason).toBe('status=404');
    }
  });

  it('404와 400을 뭉뚱그리지 않는다', async () => {
    const notFound = await pushLead(CFG, new FormData(), respond(404, 'no route'));
    const badRequest = await pushLead(CFG, new FormData(), respond(400, 'bad field'));
    expect(notFound.ok).toBe(false);
    expect(badRequest.ok).toBe(false);
    if (!notFound.ok && !badRequest.ok) {
      expect(notFound.retryable).toBe(true);
      expect(badRequest.retryable).toBe(false);
    }
  });

  it('3xx는 성공도 아니고 재시도 대상도 아니다', async () => {
    // fetch가 리다이렉트를 따르므로 여기까지 오는 3xx는 설정 문제다. 다시 보내도 같다.
    const out = await pushLead(CFG, new FormData(), respond(302, 'moved'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(302);
      expect(out.retryable).toBe(false);
    }
  });

  it('fetch가 reject하면 던지지 않고 재시도 대상 실패를 돌려준다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    const out = await pushLead(CFG, new FormData(), fake);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBeNull();
      expect(out.retryable).toBe(true);
      expect(out.reason).toContain('network');
    }
  });
});

describe('pushLead 실패 사유의 안전성', () => {
  it('응답이 시크릿을 되비춰도 사유에 남기지 않는다', async () => {
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(401, `bad secret: ${CFG.secret} (x-homepage-secret)`),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).not.toContain('sh-secret-42');
      expect(out.reason).toContain('status=401');
    }
  });

  it('시크릿이 자르는 경계에 걸쳐도 조각조차 남기지 않는다', async () => {
    // 자른 뒤에 마스킹하면 경계에 걸친 시크릿이 두 조각으로 갈리고,
    // 어느 조각도 전체와 일치하지 않아 앞 조각이 그대로 사유에 남는다.
    const secret = 'sk-live-0123456789abcdef0123456789abcdef';
    const cfg = { endpoint: CFG.endpoint, secret };
    // 시크릿(40자)이 발췌 상한(120자)에 걸치도록 앞을 정확히 100자로 채운다.
    // 앞 20자는 자르는 선 안쪽, 뒤 20자는 바깥쪽에 놓인다.
    const prefix = 'connect failed ';
    const fake: typeof fetch = async () => {
      throw new Error(`${prefix}${'x'.repeat(100 - prefix.length)}${secret} trailing`);
    };

    const out = await pushLead(cfg, new FormData(), fake);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).not.toContain(secret);
      for (let i = 0; i + 16 <= secret.length; i += 1) {
        expect(out.reason).not.toContain(secret.slice(i, i + 16));
      }
    }
  });

  it('네트워크 오류 메시지에 시크릿이 섞여도 남기지 않는다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error(`connect failed with sh-secret-42`);
    };
    const out = await pushLead(CFG, new FormData(), fake);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).not.toContain('sh-secret-42');
  });

  it('오류 본문의 고객 PII를 사유에 넣지 않는다', async () => {
    // CRM의 400은 "필수 항목 누락·형식 오류"다. 어느 값이 잘못됐는지 알려주려고
    // 그 값을 되비추는 것이 가장 흔한 형태라, 본문 발췌를 남기면 고객 PII가 그대로 박힌다.
    const body = {
      error: 'phone 형식이 올바르지 않습니다: 010-1234-5678',
      message: '홍길동 님의 요청을 처리할 수 없습니다',
      details: { name: '홍길동', phone: '010-1234-5678' },
    };
    const out = await pushLead(CFG, new FormData(), respond(400, JSON.stringify(body), JSON_H));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('status=400');
      expect(out.reason).not.toContain('홍길동');
      expect(out.reason).not.toContain('010-1234-5678');
      expect(out.reason).not.toContain('형식이 올바르지 않습니다');
    }
  });

  it('code는 영문자로 시작하는 식별자일 때만 남긴다', async () => {
    const ok = await pushLead(
      CFG,
      new FormData(),
      respond(400, JSON.stringify({ code: 'MISSING_FIELD' }), JSON_H),
    );
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.reason).toBe('status=400 code=MISSING_FIELD');

    // 전화번호가 code 자리에 들어와도 숫자로 시작하니 통과하지 못한다.
    for (const code of ['010-1234-5678', '홍길동', 'x'.repeat(60), '']) {
      const out = await pushLead(
        CFG,
        new FormData(),
        respond(400, JSON.stringify({ code }), JSON_H),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('status=400');
    }
  });

  it('본문이 JSON이 아니면 상태코드만 남긴다', async () => {
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(400, '<html>홍길동 010-1234-5678</html>'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('status=400');
  });

  it('code 자리에 시크릿이 와도 마스킹한다', async () => {
    const out = await pushLead(
      CFG,
      new FormData(),
      respond(401, JSON.stringify({ code: CFG.secret }), JSON_H),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).not.toContain('sh-secret-42');
      expect(out.reason).toBe('status=401 code=***');
    }
  });

  it('본문을 읽다 끊겨도 상태코드만 남기고 던지지 않는다', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('stream broke'));
          },
        }),
        { status: 500, headers: JSON_H },
      );
    const out = await pushLead(CFG, new FormData(), fake);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('status=500');
      expect(out.retryable).toBe(true);
    }
  });

  it('네트워크 오류 사유의 길이를 제한하고 제어문자를 남기지 않는다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error(`a\n\tb${'x'.repeat(5000)}`);
    };
    const out = await pushLead(CFG, new FormData(), fake);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason.length).toBeLessThanOrEqual(200);
      expect(/[\u0000-\u001f\u007f]/.test(out.reason)).toBe(false);
    }
  });
});
