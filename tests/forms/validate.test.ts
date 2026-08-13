import { describe, it, expect } from 'vitest';
import { normalizePhone, isValidTel, validateText } from '../../src/lib/forms/validate';
import { findForm } from '../../src/lib/forms/definitions';

describe('normalizePhone', () => {
  it('휴대폰 11자리를 하이픈 형태로 만든다', () => {
    expect(normalizePhone('01012345678')).toBe('010-1234-5678');
    expect(normalizePhone('010-1234-5678')).toBe('010-1234-5678');
    expect(normalizePhone('010 1234 5678')).toBe('010-1234-5678');
  });

  it('10자리 구형 번호를 처리한다', () => {
    expect(normalizePhone('0111234567')).toBe('011-123-4567');
  });

  it('02 지역번호를 올바르게 끊는다', () => {
    expect(normalizePhone('0212345678')).toBe('02-1234-5678');
    expect(normalizePhone('021234567')).toBe('02-123-4567');
  });

  it('해석할 수 없으면 원문을 다듬어서 돌려준다', () => {
    expect(normalizePhone('  +82 10-1234-5678 ')).toBe('+82 10-1234-5678');
  });
});

describe('isValidTel', () => {
  it('CF7 wpcf7_is_tel과 같은 문자만 허용한다', () => {
    expect(isValidTel('010-1234-5678')).toBe(true);
    expect(isValidTel('+82 (10) 1234.5678')).toBe(true);
    expect(isValidTel('02/123/4567')).toBe(true);
  });

  it('숫자가 하나도 없으면 거부한다', () => {
    expect(isValidTel('---')).toBe(false);
    expect(isValidTel('')).toBe(false);
  });

  it('한글이나 알파벳이 섞이면 거부한다', () => {
    expect(isValidTel('전화주세요')).toBe(false);
    expect(isValidTel('010-1234-5678 내선')).toBe(false);
  });
});

function makeGetters(fields: Record<string, string | string[]>) {
  const get = (n: string) => {
    const v = fields[n];
    return typeof v === 'string' ? v : null;
  };
  const getAll = (n: string) => {
    const v = fields[n];
    return Array.isArray(v) ? v : [];
  };
  return { get, getAll };
}

describe('validateText', () => {
  const newCar = findForm('583', '580')!;
  const detailing = findForm('631', '626')!;
  const analysis = findForm('584', '609')!;

  it('정상 입력을 통과시킨다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '010-1234-5678',
      'your-car': 'BMW 520i',
      'your-method[]': ['리스', '할부'],
      'your-pay[]': ['이번 달'],
      'your-message': '견적 부탁드립니다',
      dl_ref: 'naver',
      'referer-page': '/lease/',
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      name: '홍길동',
      phone: '010-1234-5678',
      car: 'BMW 520i',
      methods: ['리스', '할부'],
      payPeriod: ['이번 달'],
      message: '견적 부탁드립니다',
      ref: 'naver',
      refererPage: '/lease/',
    });
  });

  it('필수 필드가 비면 원본 문구로 invalid를 낸다', () => {
    const { get, getAll } = makeGetters({ 'your-name': '  ', 'your-phone': '', 'your-car': 'X' });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([
      { field: 'your-name', message: '정확하게 입력 부탁드립니다.' },
      { field: 'your-phone', message: '정확하게 입력 부탁드립니다.' },
      { field: 'your-method', message: '정확하게 입력 부탁드립니다.' },
      { field: 'your-pay', message: '정확하게 입력 부탁드립니다.' },
    ]);
  });

  it('체크박스 에러의 field에는 대괄호가 없다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '010-1234-5678',
      'your-car': 'X',
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([{ field: 'your-method', message: '정확하게 입력 부탁드립니다.' }]);
  });

  it('analysis는 별도 문구를 쓰고 체크박스를 요구하지 않는다', () => {
    const { get, getAll } = makeGetters({ 'your-name': '', 'your-phone': '010-1234-5678' });
    const r = validateText(analysis, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([
      { field: 'your-name', message: '성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다.' },
    ]);
  });

  it('detailing은 your-telephone을 연락처로 읽는다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-telephone': '010-1111-2222',
      'your-car': '아반떼',
      'your-method[]': ['디테일링'],
      'your-pay[]': ['미정'],
      it_ref: 'kakao',
    });
    const r = validateText(detailing, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.phone).toBe('010-1111-2222');
    expect(r.data.ref).toBe('kakao');
  });

  it('허용 목록 밖 체크박스 값은 버리지 않고 거부한다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '010-1234-5678',
      'your-car': 'X',
      'your-method[]': ['리스', '<script>'],
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([
      { field: 'your-method', message: '이 입력란을 통해 정의되지 않은 값이 제출되었습니다.' },
    ]);
  });

  it('전화번호 형식이 아니면 거부한다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '전화주세요',
      'your-car': 'X',
      'your-method[]': ['리스'],
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([
      { field: 'your-phone', message: '정확한 휴대폰 번호를 입력해주세요.' },
    ]);
  });

  it('minlength 13 미만이면 거부한다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '010-123',
      'your-car': 'X',
      'your-method[]': ['리스'],
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([
      { field: 'your-phone', message: '정확한 휴대폰 번호를 입력해주세요.' },
    ]);
  });

  it('detailing은 최소 길이 제한이 없다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-telephone': '02-123',
      'your-car': 'X',
      'your-method[]': ['디테일링'],
      'your-pay[]': ['미정'],
    });
    expect(validateText(detailing, get, getAll).ok).toBe(true);
  });

  it('길이 초과를 잘라내지 않고 invalid로 처리한다', () => {
    const { get, getAll } = makeGetters({
      'your-name': 'ㄱ'.repeat(401),
      'your-phone': '010-1234-5678',
      'your-car': 'X',
      'your-method[]': ['리스'],
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid).toEqual([{ field: 'your-name', message: '내용이 너무 깁니다.' }]);
  });

  it('선택 필드가 없으면 null이다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '010-1234-5678',
      'your-car': 'X',
      'your-method[]': ['리스'],
      'your-pay[]': ['이번 달'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.message).toBeNull();
    expect(r.data.ref).toBeNull();
    expect(r.data.refererPage).toBeNull();
  });
});
