import { FORMS, type FormKey } from './definitions';
import type { SubmissionRow } from './db';

/**
 * 차선생 CRM 리드 연동. 계약 정본은 docs/crm-lead-integration.md 다.
 *
 * 이 모듈은 순수 모듈이다. cloudflare:workers를 import하지 않고, 바깥에서
 * fetch를 주입받는다. CRM 전송은 어디까지나 부수 효과이고 리드의 정본은
 * Supabase다 — 여기서 무엇이 실패하든 제출 자체를 실패로 만들면 안 된다.
 */

export type CrmType = 'consult' | 'quote';

/** 계약에 없는 폼은 null이다. 중고차·차량시공은 CRM 대상이 아니다. */
export function crmTypeFor(formKey: FormKey): CrmType | null {
  switch (formKey) {
    case 'analysis':
      return 'quote';
    case 'consulting-new-car':
      return 'consult';
    default:
      return null;
  }
}

/** CRM이 받아주는 form_key 목록. crmTypeFor에서 파생시켜 두 곳이 어긋나지 않게 한다. */
// 폼 목록을 손으로 베끼지 않고 FORMS에서 뽑는다. 폼이 늘어나면 여기도 저절로 따라온다.
// (583이 신차·중고차 두 페이지에 공유되므로 key 중복을 제거한다.)
export const CRM_FORM_KEYS: readonly FormKey[] = [...new Set(FORMS.map((f) => f.key))].filter(
  (k) => crmTypeFor(k) !== null,
);

export interface CrmConfig {
  endpoint: string;
  /** Workers Secret. 절대 로그·DB·반환값에 남기지 않는다. */
  secret: string;
}

/** R2에서 읽어 온 첨부 실체. type=quote에서만 쓴다. */
export interface CrmAttachment {
  n: number;
  filename: string;
  contentType: string;
  body: ArrayBuffer;
}

export type CrmOutcome =
  | {
      ok: true;
      /** 같은 submissionId 재전송이라 CRM이 200 + duplicate:true를 준 경우 */
      duplicate: boolean;
      customerId: string | null;
      customerCode: string | null;
    }
  | {
      ok: false;
      /** 응답을 받았으면 HTTP 상태코드, 네트워크 오류면 null */
      status: number | null;
      /** DB 컬럼과 로그에 그대로 남겨도 안전한 짧은 요약 */
      reason: string;
      retryable: boolean;
    };

/** 첨부는 최대 2개(file1, file2)라는 계약 제한. */
const MAX_CRM_FILES = 2;

/** crm_error 컬럼에 들어갈 길이 상한. 본문 발췌는 이보다 더 짧게 자른다. */
const MAX_REASON = 200;
const MAX_EXCERPT = 120;

function put(form: FormData, name: string, value: string | null | undefined): void {
  // 빈 값은 필드 자체를 생략한다. 빈 문자열을 보내면 CRM이 "값 있음"으로 받는다.
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v === '') return;
  form.set(name, v);
}

/**
 * 계약의 필드 매핑대로 multipart 본문을 만든다.
 *
 * - submissionId는 row.id 원본 그대로(접두사 없음)
 * - purchaseMethod/purchaseTiming은 methods/pay_period의 첫 원소 하나뿐.
 *   지금 폼은 라디오라 최대 1개이고, 배열이 비면 필드를 아예 넣지 않는다.
 * - 첨부는 type=quote에서만, 들어온 순서대로 file1·file2에 채운다.
 *
 * CRM 대상이 아닌 폼으로 호출하는 것은 호출부의 버그이므로 던진다.
 */
export function buildCrmForm(row: SubmissionRow, attachments: CrmAttachment[]): FormData {
  const type = crmTypeFor(row.form_key);
  if (type === null) {
    throw new Error(`CRM 연동 대상이 아닌 폼입니다: ${row.form_key}`);
  }

  const form = new FormData();
  form.set('type', type);
  form.set('submissionId', row.id);
  form.set('name', row.name);
  form.set('phone', row.phone);
  put(form, 'inquiry', row.message);

  if (type === 'consult') {
    put(form, 'desiredModel', row.car);
    put(form, 'purchaseMethod', row.methods[0]);
    put(form, 'purchaseTiming', row.pay_period[0]);
  } else {
    for (const [i, att] of attachments.slice(0, MAX_CRM_FILES).entries()) {
      form.set(`file${i + 1}`, new File([att.body], att.filename, { type: att.contentType }));
    }
  }

  return form;
}

/** 제어문자를 지우고 길이를 잘라, 로그·DB에 넣어도 안전한 발췌를 만든다. */
function excerpt(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (flat.length <= MAX_EXCERPT) return flat;
  return `${flat.slice(0, MAX_EXCERPT)}…`;
}

/**
 * 만에 하나 CRM이 오류 본문에 우리 시크릿을 되비추더라도 그대로 저장되지 않게 한다.
 * (401 디버그 응답이 헤더를 echo하는 사례가 드물지 않다.)
 */
function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('***');
}

function fail(status: number | null, detail: string, retryable: boolean, secret: string): CrmOutcome {
  const head = status === null ? 'network' : `status=${status}`;
  // 시크릿 마스킹과 길이 제한은 1차 방어선이 아니라 최후의 방어선이다.
  // 1차 방어는 애초에 기계 판독용 값만 detail에 담는 것이다(describeCrmError 참고).
  const body = redactSecret(detail, secret);
  const reason = body === '' ? head : `${head} ${body}`;
  return {
    ok: false,
    status,
    reason: reason.length > MAX_REASON ? reason.slice(0, MAX_REASON) : reason,
    retryable,
  };
}

/**
 * 기계 판독용 코드로만 인정하는 형태.
 * 반드시 영문자로 시작해야 한다 — 이 한 줄이 고객 입력을 걸러낸다.
 * 전화번호("010-1234-5678")는 숫자로 시작하니 탈락하고, 한글 이름은 ASCII가 아니라 탈락한다.
 */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;

/**
 * 실패 응답을 로그·crm_error 컬럼에 남겨도 안전한 요약으로 바꾼다.
 *
 * db.ts의 describeError와 같은 규율이다. CRM의 400은 "필수 항목 누락·형식 오류"인데,
 * 잘못된 값을 알려주는 가장 흔한 방식이 그 값을 되비추는 것이다. 즉 본문 발췌를 남기면
 * 고객 이름·전화번호가 그대로 DB 컬럼과 워커 로그에 박힌다.
 * 그래서 본문에서 가져오는 것은 화이트리스트를 통과한 code 하나뿐이고, 나머지는 전부 버린다.
 * error 같은 자유 문구 필드는 값을 되비추지 않는다고 보장할 수 없으므로 아예 쓰지 않는다.
 * JSON이 아니면 상태코드만 남는다.
 */
async function describeCrmError(res: Response): Promise<string> {
  try {
    const json: unknown = await res.json();
    if (json !== null && typeof json === 'object') {
      const code = (json as Record<string, unknown>).code;
      if (typeof code === 'string' && ERROR_CODE.test(code)) return `code=${code}`;
    }
  } catch {
    // JSON이 아니거나 본문을 읽다 끊겼다. 상태코드만으로 충분하다.
  }
  return '';
}

/**
 * CRM에 리드를 전송하고 결과를 분류한다. 던지지 않는다 — 모든 결과가 CrmOutcome이다.
 *
 * 201 성공 / 200 성공(중복) / 503·기타 5xx·네트워크 오류는 재시도 대상 /
 * 400·401·413·415를 포함한 모든 4xx는 재시도해도 소용없다.
 */
export async function pushLead(
  cfg: CrmConfig,
  form: FormData,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: { 'x-homepage-secret': cfg.secret },
      body: form,
    });
  } catch (err) {
    // 네트워크 오류는 CRM이 받았는지조차 모른다. submissionId가 멱등키라 재시도해도 안전하다.
    // 이 메시지는 상대측 본문이 아니라 우리 런타임이 만든 문자열이라("fetch failed" 등)
    // 고객 입력을 되비출 경로가 없다. 그래서 여기서만 문구를 남긴다.
    const msg = err instanceof Error ? excerpt(err.message) : '';
    return fail(null, msg, true, cfg.secret);
  }

  if (res.status === 201 || res.status === 200) {
    let payload: Record<string, unknown> = {};
    try {
      const json: unknown = await res.json();
      if (json !== null && typeof json === 'object') payload = json as Record<string, unknown>;
    } catch {
      // 본문이 JSON이 아니어도 상태코드만으로 성공 판정에는 지장이 없다.
    }
    return {
      ok: true,
      duplicate: res.status === 200 || payload.duplicate === true,
      customerId: typeof payload.customerId === 'string' ? payload.customerId : null,
      customerCode: typeof payload.customerCode === 'string' ? payload.customerCode : null,
    };
  }

  const detail = await describeCrmError(res);
  // 5xx는 CRM 쪽 일시 상태(503 = 연동 미설정 포함)로 보고 재시도한다.
  // 4xx는 같은 본문을 다시 보내도 같은 답이 오므로 재시도하지 않는다.
  return fail(res.status, detail, res.status >= 500, cfg.secret);
}
