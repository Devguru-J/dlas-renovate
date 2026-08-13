import { CRM_FORM_KEYS } from './crm';
import type { FormKey } from './definitions';
import type { AttachmentMeta } from './files';

export interface SubmissionRow {
  id: string;
  form_key: FormKey;
  form_subject: string;
  name: string;
  phone: string;
  car: string | null;
  methods: string[];
  pay_period: string[];
  message: string | null;
  ref: string | null;
  referer_page: string | null;
  source_page: string | null;
  attachments: AttachmentMeta[];
  email_sent_at: string | null;
  email_error: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

/**
 * PostgREST 오류 응답을 로그에 남겨도 안전한 요약으로 바꾼다.
 * 제약조건 위반 시 PostgREST는 Postgres의 message/details를 그대로 돌려주는데,
 * details는 "Failing row contains (…)" 형태로 고객 이름·전화번호를 담는다.
 * 그 값이 워커 로그와 email_error 컬럼에 남지 않도록 상태코드와 기계 판독용
 * code(있으면 일반적인 hint)만 남기고 본문은 버린다.
 */
async function describeError(res: Response): Promise<string> {
  const parts = [`status=${res.status}`];
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.code === 'string' && obj.code !== '') parts.push(`code=${obj.code}`);
      if (typeof obj.hint === 'string' && obj.hint !== '') parts.push(`hint=${obj.hint}`);
    }
  } catch {
    // JSON이 아니면 상태코드만 남긴다. 원문은 어떤 경우에도 포함하지 않는다.
  }
  return parts.join(' ');
}

export async function insertSubmission(
  cfg: SupabaseConfig,
  row: SubmissionRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/rest/v1/contact_submissions`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    throw new Error(`supabase insert failed: ${await describeError(res)}`);
  }
}

/**
 * 알림 발송 결과를 기록한다. 보조 경로라 실패해도 던지지 않는다.
 * 여기서 던지면 이미 저장에 성공한 제출을 실패로 응답하게 된다.
 */
export async function updateEmailStatus(
  cfg: SupabaseConfig,
  id: string,
  patch: { email_sent_at: string | null; email_error: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(
      `${base}/rest/v1/contact_submissions?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      console.error('email status update failed', await describeError(res));
    }
  } catch (err) {
    console.error('email status update failed', err);
  }
}

/**
 * CRM 전송 결과 패치. 성공이면 crm_synced_at·crm_record_id를 채우고 crm_error를 비운다.
 * 실패면 crm_synced_at을 건드리지 않고 crm_error에 짧은 사유만 남긴다.
 * 어느 쪽이든 crm_attempts·crm_last_attempt_at은 갱신한다.
 */
export interface CrmStatusPatch {
  crm_synced_at?: string | null;
  crm_record_id?: string | null;
  crm_error: string | null;
  crm_attempts: number;
  crm_last_attempt_at: string;
}

/**
 * CRM 전송 결과를 기록한다. updateEmailStatus와 같은 이유로 절대 던지지 않는다.
 * 이미 저장에 성공한 제출을 부수 기록 실패 때문에 오류로 만들 수는 없다.
 */
export async function updateCrmStatus(
  cfg: SupabaseConfig,
  id: string,
  patch: CrmStatusPatch,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(
      `${base}/rest/v1/contact_submissions?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      console.error('crm status update failed', await describeError(res));
    }
  } catch (err) {
    console.error('crm status update failed', err);
  }
}

/**
 * 재시도 상한. 상한이 있어야 영구 실패 건(400·401·415 등)을 영원히 두드리지 않는다.
 * 그보다 오래 실패한다면 자동 재시도로 풀릴 문제가 아니라 사람이 봐야 하는 문제다.
 */
export const CRM_MAX_ATTEMPTS = 8;

/**
 * 같은 행을 다시 집기까지의 최소 간격.
 *
 * 이게 없으면 재시도 창이 크론 주기에 종속된다 — 1분마다 도는 크론이면 8회가 8분 만에
 * 소진되고, 그보다 긴 503 장애를 만난 리드는 누가 손으로 카운터를 되돌릴 때까지 멈춘다.
 * 30분 × 8회로 묶어 두면 크론이 얼마나 자주 돌든 재시도 창이 최소 4시간은 확보된다.
 * 즉 상한은 "몇 번"이 아니라 "얼마 동안"을 뜻하게 된다.
 */
export const CRM_RETRY_SPACING_MS = 30 * 60 * 1000;

/** SubmissionRow가 실제로 쓰는 컬럼만 뽑는다. 필요 없는 PII까지 끌고 오지 않는다. */
const SUBMISSION_COLUMNS = [
  'id',
  'form_key',
  'form_subject',
  'name',
  'phone',
  'car',
  'methods',
  'pay_period',
  'message',
  'ref',
  'referer_page',
  'source_page',
  'attachments',
  'email_sent_at',
  'email_error',
  'ip_hash',
  'user_agent',
].join(',');

/**
 * 아직 CRM에 못 보낸 리드를 오래된 순으로 가져온다.
 * 조건: 미동기(crm_synced_at is null) + CRM 대상 폼 + 시도 상한 미도달
 *      + (한 번도 시도 안 했거나 마지막 시도가 CRM_RETRY_SPACING_MS보다 오래됨).
 * 실패하면 던진다 — 호출부는 크론이므로 여기서 던져도 고객 제출에는 영향이 없다.
 */
export async function fetchPendingCrmLeads(
  cfg: SupabaseConfig,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<SubmissionRow[]> {
  const base = cfg.url.replace(/\/+$/, '');
  const cutoff = new Date(now.getTime() - CRM_RETRY_SPACING_MS).toISOString();
  const params = new URLSearchParams();
  params.set('select', SUBMISSION_COLUMNS);
  params.set('crm_synced_at', 'is.null');
  params.set('form_key', `in.(${CRM_FORM_KEYS.join(',')})`);
  params.set('crm_attempts', `lt.${CRM_MAX_ATTEMPTS}`);
  params.set(
    'or',
    `(crm_last_attempt_at.is.null,crm_last_attempt_at.lt.${cutoff})`,
  );
  params.set('order', 'created_at.asc');
  params.set('limit', String(limit));

  const res = await fetchImpl(`${base}/rest/v1/contact_submissions?${params.toString()}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`supabase select failed: ${await describeError(res)}`);
  }
  return (await res.json()) as SubmissionRow[];
}

export async function fetchAttachments(
  cfg: SupabaseConfig,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AttachmentMeta[]> {
  const base = cfg.url.replace(/\/+$/, '');
  const res = await fetchImpl(
    `${base}/rest/v1/contact_submissions?id=eq.${encodeURIComponent(id)}&select=attachments`,
    {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`supabase select failed: ${await describeError(res)}`);
  }
  const rows = (await res.json()) as { attachments: AttachmentMeta[] }[];
  return rows[0]?.attachments ?? [];
}
