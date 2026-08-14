import type { AttachmentMeta } from './files';

/**
 * 같은 내용의 제출을 중복으로 보지 않는 시간 폭.
 *
 * 연타는 몇 백 밀리초 안에 몰려 오지만, 폭을 그만큼 짧게 잡으면 브라우저 재시도처럼
 * 몇 초 뒤에 오는 중복을 놓친다. 반대로 너무 길게 잡으면 "방금 문의했는데 답이 없어
 * 다시 보낸다"는 정상 재문의까지 삼킨다. 10분은 그 사이의 타협이다.
 */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** dedupeKey가 보는 필드만 추린 것. SubmissionRow가 그대로 들어맞는다. */
export interface DedupeInput {
  form_key: string;
  name: string;
  phone: string;
  car: string | null;
  methods: string[];
  pay_period: string[];
  message: string | null;
  attachments: AttachmentMeta[];
}

const encoder = new TextEncoder();

/**
 * 중복 판정용 해시.
 *
 * 원문이 아니라 sha256을 저장한다 — 이 컬럼에 고객 이름·연락처가 남지 않도록 하기
 * 위해서다(ip_hash와 같은 원칙). 시간버킷을 재료에 섞어, 같은 내용이라도 버킷이
 * 다르면 다른 키가 되게 한다. 그래야 나중의 정상 재문의를 막지 않는다.
 *
 * 버킷 경계에 정확히 걸친 연타(약 0.03% 확률)는 두 버킷으로 나뉘어 통과한다.
 * 그 경우에도 화면 쪽 잠금(dl-submit-once.js)이 이미 막고 있으므로 실제로 새는 건
 * 두 방어가 동시에 빗나갈 때뿐이다.
 */
export async function dedupeKey(input: DedupeInput, now: Date): Promise<string> {
  // 값에 나올 수 없는 제어문자로 잇는다. 흔한 구분자를 쓰면 ['a','bc']와 ['ab','c']가
  // 같은 문자열이 되어 서로 다른 제출이 중복으로 오인될 수 있다.
  const UNIT = '\u0001';
  const FIELD = '\u0000';
  const bucket = Math.floor(now.getTime() / DEDUPE_WINDOW_MS);
  const parts = [
    input.form_key,
    input.name,
    input.phone,
    input.car ?? '',
    input.methods.join(UNIT),
    input.pay_period.join(UNIT),
    input.message ?? '',
    input.attachments.map((a) => `${a.filename}:${a.size}`).join(UNIT),
    String(bucket),
  ];
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join(FIELD)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
