import { describe, it, expect } from 'vitest';
import { cf7Response, FALLBACK_MESSAGES } from '../../src/lib/forms/cf7';
import { findForm, orderInvalidFields } from '../../src/lib/forms/definitions';

describe('cf7Response', () => {
  it('성공 응답 형태가 CF7 규약과 맞는다', async () => {
    const def = findForm('584', '609')!;
    const res = cf7Response(def.unitTag, def.cf7Id, 'mail_sent', def.statusMessages.mail_sent);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // 원본 dlas.co.kr의 응답과 같은 키 구성이다.
    expect(await res.json()).toEqual({
      contact_form_id: 584,
      status: 'mail_sent',
      message: '신청완료 되었습니다. 빠른 연락 드리도록 하겠습니다.',
      invalid_fields: [],
      posted_data_hash: '',
      into: '#wpcf7-f584-p609-o1',
    });
  });

  it('폼마다 다른 상태 문구를 그대로 싣는다', async () => {
    const newCar = findForm('583', '580')!;
    const res = cf7Response(
      newCar.unitTag, newCar.cf7Id, 'mail_sent', newCar.statusMessages.mail_sent,
    );
    expect((await res.json()).message).toBe(
      '찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다.',
    );
  });

  it('검증 실패 시 invalid_fields를 담는다', async () => {
    const def = findForm('583', '580')!;
    const res = cf7Response(
      def.unitTag,
      def.cf7Id,
      'validation_failed',
      def.statusMessages.validation_failed,
      [{ field: 'your-name', message: '정확하게 입력 부탁드립니다.' }],
    );
    const body = await res.json();
    expect(body.status).toBe('validation_failed');
    expect(body.message).toBe('성함, 연락처, 차종, 구매방식, 구매시기를 모두 입력 부탁드립니다.');
    expect(body.invalid_fields).toEqual([
      {
        field: 'your-name',
        message: '정확하게 입력 부탁드립니다.',
        idref: null,
        error_id: 'wpcf7-f583-p580-o1-ve-your-name',
      },
    ]);
  });

  it('CF7 JS가 fetch를 실패로 보지 않도록 항상 200을 낸다', () => {
    for (const s of ['spam', 'mail_failed', 'validation_failed'] as const) {
      expect(cf7Response('t', '583', s, FALLBACK_MESSAGES[s]).status).toBe(200);
    }
  });

  it('invalid_fields를 원본과 같은 SWV 스키마 순서로 정렬한다', () => {
    const def = findForm('583', '580')!;
    const ordered = orderInvalidFields(def, [
      { field: 'your-car', message: 'c' },
      { field: 'your-name', message: 'n' },
      { field: 'your-pay', message: 'p' },
      { field: 'your-method', message: 'm' },
      { field: 'your-phone', message: 't' },
    ]);
    expect(ordered.map((f) => f.field)).toEqual([
      'your-method', 'your-pay', 'your-name', 'your-phone', 'your-car',
    ]);
  });

  it('폴백 문구가 네 상태 모두 정의되어 있다', () => {
    for (const s of ['mail_sent', 'mail_failed', 'validation_failed', 'spam'] as const) {
      expect(FALLBACK_MESSAGES[s].length).toBeGreaterThan(0);
    }
  });
});
