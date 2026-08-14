import type { FormDefinition } from './definitions';

const MAX_TEXT = 400;
const MAX_MESSAGE = 2000;

/**
 * 숫자만 뽑아 한국 번호 형태로 맞춘다.
 * 해석할 수 없는 형태(해외 번호 등)는 잃지 않도록 원문을 그대로 돌려준다.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (digits.startsWith('02')) {
    if (digits.length === 10) return `02-${digits.slice(2, 6)}-${digits.slice(6)}`;
    if (digits.length === 9) return `02-${digits.slice(2, 5)}-${digits.slice(5)}`;
    return trimmed;
  }
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return trimmed;
}

/**
 * CF7 6.0.6 wpcf7_is_tel()의 이식.
 * 정본은 원본 서버의 wp-content/plugins/contact-form-7/includes/validation-functions.php 이며,
 * 아래 순서와 문자 집합은 그 PHP 코드를 그대로 옮긴 것이다.
 *   1) # 또는 * 뒤(내선번호)를 잘라낸다
 *   2) 구분 문자 ()/.*#공백- 를 모두 제거한다
 *   3) + 또는 00으로 시작하면 국제번호로 보고 앞의 +/0을 하나의 +로 바꾼다
 *   4) 남은 값이 [+]숫자 형태여야 하고, 길이가 6~15자여야 한다
 * 원본 서버에 이 함수를 바꾸는 필터는 없다(wpcf7_is_tel 훅 사용처 없음).
 */
export function isValidTel(raw: string): boolean {
  // PHP의 `.`는 줄바꿈에 걸리지 않으므로 JS에서도 줄바꿈은 제외한다.
  let text = raw.replace(/[#*][^\n]*$/, '');
  // PHP의 \s는 [ \t\n\r\f\v]다. JS의 \s는 유니코드 공백까지 포함하므로 직접 나열한다.
  text = text.replace(/[()/.*#\t\n\r\f\v -]+/g, '');

  if (text.startsWith('+') || text.startsWith('00')) {
    text = `+${text.replace(/^[+0]+/, '')}`;
  }

  if (!/^[+]?[0-9]+$/.test(text)) return false;
  return text.length > 5 && text.length < 16;
}

export interface TextResult {
  name: string;
  phone: string;
  car: string | null;
  methods: string[];
  payPeriod: string[];
  message: string | null;
  ref: string | null;
  refererPage: string | null;
}

export type TextValidation =
  | { ok: true; data: TextResult }
  | { ok: false; invalid: { field: string; message: string }[] };

function optional(raw: string | null, max: number): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  return t === '' ? null : t.slice(0, max);
}

/** 전송 이름(your-method[])을 에러용 이름(your-method)으로 바꾼다 */
function errorFieldName(name: string): string {
  return name.endsWith('[]') ? name.slice(0, -2) : name;
}

/**
 * 파일을 제외한 모든 입력을 검증한다.
 * get은 단일 값, getAll은 다중 값(체크박스) 접근자다. FormData에 직접 의존하지 않아
 * Cloudflare 런타임 없이 테스트할 수 있다.
 */
export function validateText(
  def: FormDefinition,
  get: (name: string) => string | null,
  getAll: (name: string) => string[],
): TextValidation {
  const m = def.messages;
  const invalid: { field: string; message: string }[] = [];
  const add = (field: string, message: string) => {
    invalid.push({ field: errorFieldName(field), message });
  };

  const methodsRaw = getAll('your-method[]');
  const payRaw = getAll('your-pay[]');

  // 1. 필수. 파일 필드는 엔드포인트가 따로 본다.
  for (const field of def.requiredFields) {
    if (def.fileFields.includes(field)) continue;
    const empty =
      field === 'your-method[]'
        ? methodsRaw.length === 0
        : field === 'your-pay[]'
          ? payRaw.length === 0
          : (get(field) ?? '').trim() === '';
    if (empty) add(field, m.required);
  }

  // 2. 길이
  for (const [field, max] of [
    ['your-name', MAX_TEXT],
    [def.phoneField, MAX_TEXT],
    ['your-car', MAX_TEXT],
    ['your-message', MAX_MESSAGE],
  ] as const) {
    const v = get(field);
    if (v !== null && v.trim().length > max) add(field, m.tooLong);
  }

  // 3. 전화 형식. 비어 있는 경우는 1번이 이미 잡았다.
  const phoneRaw = (get(def.phoneField) ?? '').trim();
  if (phoneRaw !== '') {
    if (!isValidTel(phoneRaw)) {
      add(def.phoneField, m.tel);
    } else if (def.phoneMinLength !== null && phoneRaw.length < def.phoneMinLength) {
      add(def.phoneField, m.telShort);
    }
  }

  // 4. 체크박스 화이트리스트. 정상 브라우저에서는 나올 수 없는 입력이다.
  for (const [field, raw, allowed] of [
    ['your-method[]', methodsRaw, def.methodValues],
    ['your-pay[]', payRaw, def.payValues],
  ] as const) {
    if (raw.some((v) => !allowed.includes(v))) add(field, m.notEnum);
  }

  if (invalid.length > 0) return { ok: false, invalid };

  const dedupe = (values: string[]) => Array.from(new Set(values));

  return {
    ok: true,
    data: {
      name: (get('your-name') ?? '').trim(),
      phone: normalizePhone(phoneRaw),
      car: optional(get('your-car'), MAX_TEXT),
      methods: dedupe(methodsRaw),
      payPeriod: dedupe(payRaw),
      message: optional(get('your-message'), MAX_MESSAGE),
      ref: optional(get(def.refField), MAX_TEXT),
      refererPage: optional(get('referer-page'), MAX_TEXT),
    },
  };
}
