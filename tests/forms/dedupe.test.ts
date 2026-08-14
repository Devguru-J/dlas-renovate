import { describe, it, expect } from 'vitest';
import { dedupeKey, DEDUPE_WINDOW_MS, type DedupeInput } from '../../src/lib/forms/dedupe';

function input(over: Partial<DedupeInput> = {}): DedupeInput {
  return {
    form_key: 'consulting-new-car',
    name: '강현준',
    phone: '010-9929-7324',
    car: '레이 5.0 자연흡기 8단 DCT',
    methods: ['운용리스'],
    pay_period: ['중간'],
    message: null,
    attachments: [],
    ...over,
  };
}

const T = new Date('2026-08-14T20:10:00Z');

describe('dedupeKey', () => {
  it('같은 내용을 같은 시간대에 내면 같은 키가 된다 — 연타가 여기서 걸린다', async () => {
    const a = await dedupeKey(input(), T);
    const b = await dedupeKey(input(), new Date(T.getTime() + 800));
    expect(a).toBe(b);
  });

  it('내용이 하나라도 다르면 다른 키다', async () => {
    const base = await dedupeKey(input(), T);
    const others = await Promise.all([
      dedupeKey(input({ name: '강현주' }), T),
      dedupeKey(input({ phone: '010-9929-7325' }), T),
      dedupeKey(input({ car: '레이 5.0' }), T),
      dedupeKey(input({ methods: ['할부'] }), T),
      dedupeKey(input({ pay_period: ['미정'] }), T),
      dedupeKey(input({ message: '연락 부탁드립니다' }), T),
      dedupeKey(input({ form_key: 'consulting-used-car' }), T),
    ]);
    for (const k of others) expect(k).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });

  it('시간대가 바뀌면 같은 내용이라도 다른 키다 — 나중의 정상 재문의를 막지 않는다', async () => {
    const a = await dedupeKey(input(), T);
    const b = await dedupeKey(input(), new Date(T.getTime() + DEDUPE_WINDOW_MS * 2));
    expect(a).not.toBe(b);
  });

  it('배열 항목이 다르게 쪼개진 경우를 같은 값으로 뭉개지 않는다', async () => {
    const a = await dedupeKey(input({ methods: ['운용', '리스'] }), T);
    const b = await dedupeKey(input({ methods: ['운용리스'] }), T);
    expect(a).not.toBe(b);
  });

  it('첨부 파일이 다르면 다른 키다', async () => {
    const file = (filename: string, size: number) => ({
      n: 1,
      filename,
      size,
      content_type: 'image/png',
      r2_key: 'k',
    });
    const a = await dedupeKey(input({ attachments: [file('견적서.png', 100)] }), T);
    const b = await dedupeKey(input({ attachments: [file('견적서.png', 101)] }), T);
    const c = await dedupeKey(input({ attachments: [file('다른견적서.png', 100)] }), T);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('원문이 아니라 sha256 16진수를 돌려준다 — 컬럼에 PII가 남지 않아야 한다', async () => {
    const k = await dedupeKey(input(), T);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain('강현준');
    expect(k).not.toContain('9929');
  });
});
