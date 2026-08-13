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
