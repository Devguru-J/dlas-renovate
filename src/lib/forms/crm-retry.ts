import { buildCrmForm, crmTypeFor, pushLead, type CrmAttachment, type CrmConfig } from './crm';
import {
  CRM_MAX_ATTEMPTS,
  fetchPendingCrmLeads,
  updateCrmStatus,
  type CrmStatusPatch,
  type PendingCrmLead,
  type SubmissionRow,
  type SupabaseConfig,
} from './db';
import { buildCrmAlertEmail, sendEmail, type MailConfig } from './notify';

/**
 * 아직 CRM에 못 보낸 리드를 다시 보내는 일괄 작업.
 *
 * 크론(src/worker.ts)이 부르지만 이 모듈은 워커를 모른다 — cloudflare:workers를
 * import하지 않고 필요한 것을 전부 주입받는다. 덕분에 이 파일의 판단(무엇을 성공으로
 * 볼지, 언제 포기할지, 언제 사람을 부를지)을 워커 런타임 없이 그대로 시험할 수 있다.
 *
 * 절대 던지지 않는다. 한 건이 어떻게 실패하든 나머지 건은 계속 처리한다.
 */

/**
 * R2 버킷 중 이 작업이 실제로 쓰는 부분. R2Bucket 전체를 요구하지 않는 이유는
 * 테스트가 워커 런타임 없이 이 자리를 채울 수 있게 하기 위함이다.
 */
export interface CrmRetryBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface CrmRetryDeps {
  supabase: SupabaseConfig;
  crm: CrmConfig;
  bucket: CrmRetryBucket;
  mail: MailConfig;
  fetchImpl?: typeof fetch;
}

export interface CrmRetrySummary {
  /** 이번 회차에 집어 온 건수 */
  picked: number;
  /** CRM 등록에 성공한 건수(중복 응답 포함) */
  synced: number;
  /** 실패한 건수 */
  failed: number;
  /** 담당자 알림을 보낸 건수 */
  alerted: number;
}

/**
 * 한 회차에 처리할 최대 건수. 워커 한 번의 실행 시간·서브리퀘스트 한도 안에 들어오도록
 * 묶어 둔다. 남은 건은 다음 회차가 집는다 — 오래된 순으로 가져오므로 굶는 건은 없다.
 */
const BATCH_LIMIT = 20;

/** 첨부가 R2에 없을 때의 사유. 고객 파일명은 넣지 않는다(파일명 자체가 개인정보일 수 있다). */
class MissingAttachment extends Error {
  constructor(readonly n: number) {
    super(`r2_missing n=${n}`);
  }
}

async function loadAttachments(
  bucket: CrmRetryBucket,
  row: PendingCrmLead,
): Promise<CrmAttachment[]> {
  const out: CrmAttachment[] = [];
  for (const meta of row.attachments) {
    const obj = await bucket.get(meta.r2_key);
    // 첨부 없는 견적 요청은 CRM에서 쓸모가 없다. 반쪽짜리로 보내 "성공"으로 찍히면
    // 아무도 다시 보지 않으므로, 차라리 실패로 남기고 사람을 부른다.
    if (obj === null) throw new MissingAttachment(meta.n);
    out.push({
      n: meta.n,
      filename: meta.filename,
      contentType: meta.content_type,
      body: await obj.arrayBuffer(),
    });
  }
  return out;
}

export async function runCrmRetry(
  deps: CrmRetryDeps,
  limit: number = BATCH_LIMIT,
): Promise<CrmRetrySummary> {
  const { supabase, crm, bucket, mail, fetchImpl = fetch } = deps;
  const summary: CrmRetrySummary = { picked: 0, synced: 0, failed: 0, alerted: 0 };

  let rows: PendingCrmLead[];
  try {
    rows = await fetchPendingCrmLeads(supabase, limit, fetchImpl);
  } catch (err) {
    // 조회가 안 되면 이번 회차는 아무것도 못 한다. 다음 크론이 다시 시도한다.
    console.error('crm retry: pending 조회 실패', err);
    return summary;
  }
  summary.picked = rows.length;

  // 순차 처리다. 병렬로 돌리면 상대측에 한꺼번에 몰리고, 워커의 동시 연결 한도에도 걸린다.
  for (const row of rows) {
    const outcome = await sendOne(row, { crm, bucket, fetchImpl });
    const recorded = await record({ supabase, mail, fetchImpl }, row, row.crm_attempts, outcome);

    if (recorded.synced) summary.synced += 1;
    else summary.failed += 1;
    if (recorded.alerted) summary.alerted += 1;
  }

  return summary;
}

/**
 * 제출 시점의 1차 전송. 크론을 기다리지 않고 바로 보낸다.
 *
 * 첨부는 방금 업로드한 바이트를 그대로 넘겨받는다 — R2에 다시 다녀오지 않는다.
 * 실패해도 던지지 않는다. 이 시점의 리드는 이미 Supabase에 저장되어 고객에게
 * 접수 완료로 응답된 상태이므로, CRM 전송은 여기서 실패하더라도 크론이 이어받는다.
 */
export async function syncLeadNow(
  deps: Omit<CrmRetryDeps, 'bucket'>,
  row: SubmissionRow,
  attachments: CrmAttachment[],
): Promise<void> {
  const { supabase, crm, mail, fetchImpl = fetch } = deps;
  // 계약에 없는 폼은 전송 대상이 아니다. 시도한 적 없는 것으로 남겨야
  // 크론의 조회 조건(미동기 + CRM 대상 폼)에도 걸리지 않는다.
  if (crmTypeFor(row.form_key) === null) return;

  let outcome: SendResult;
  try {
    const result = await pushLead(crm, buildCrmForm(row, attachments), fetchImpl);
    outcome = result.ok
      ? { ok: true, customerId: result.customerId }
      : { ok: false, reason: result.reason, retryable: result.retryable };
  } catch (err) {
    // pushLead는 던지지 않지만 buildCrmForm은 던질 수 있다(계약 밖 폼). 어느 쪽이든
    // 제출 응답에는 영향을 주지 않아야 하므로 여기서 삼키고 기록만 남긴다.
    console.error('crm 즉시 전송 중 예외', err);
    outcome = { ok: false, reason: 'internal_error', retryable: true };
  }

  await record({ supabase, mail, fetchImpl }, row, 0, outcome);
}

/**
 * 전송 결과를 DB에 남기고, 자동 재시도로 더 이상 풀 수 없게 된 경우에만 사람을 부른다.
 * 크론과 제출 시점이 같은 규칙을 쓰도록 한곳에 모아 둔다 — 두 경로가 어긋나면
 * "제출 때 포기한 건을 크론이 되살리는" 식의 모순이 생긴다.
 */
async function record(
  deps: { supabase: SupabaseConfig; mail: MailConfig; fetchImpl: typeof fetch },
  row: SubmissionRow,
  priorAttempts: number,
  outcome: SendResult,
): Promise<{ synced: boolean; alerted: boolean }> {
  const { supabase, mail, fetchImpl } = deps;
  const attempts = priorAttempts + 1;
  const at = new Date().toISOString();

  if (outcome.ok) {
    await updateCrmStatus(
      supabase,
      row.id,
      {
        crm_synced_at: at,
        crm_record_id: outcome.customerId,
        crm_error: null,
        crm_attempts: attempts,
        crm_last_attempt_at: at,
      },
      fetchImpl,
    );
    return { synced: true, alerted: false };
  }

  // 재시도가 무의미한 실패는 남은 예산을 소진시켜 다시 집히지 않게 한다.
  // (crm_attempts < CRM_MAX_ATTEMPTS 가 조회 조건이므로 이 한 줄이 곧 "포기"다.)
  const nextAttempts = outcome.retryable ? attempts : Math.max(CRM_MAX_ATTEMPTS, attempts);
  const patch: CrmStatusPatch = {
    // crm_synced_at은 아예 넣지 않는다. null로 덮어쓰면 이미 성공한 건을
    // 되돌릴 위험이 생긴다(경합으로 순서가 뒤집힌 응답이 늦게 도착하는 경우).
    crm_error: outcome.reason,
    crm_attempts: nextAttempts,
    crm_last_attempt_at: at,
  };
  await updateCrmStatus(supabase, row.id, patch, fetchImpl);

  // 더 이상 자동으로 따라잡을 수 없게 된 순간에만 부른다. 그 전까지는 조용히 재시도한다.
  if (nextAttempts < CRM_MAX_ATTEMPTS) return { synced: false, alerted: false };
  await alert(mail, row, nextAttempts, outcome.reason, fetchImpl);
  return { synced: false, alerted: true };
}

type SendResult =
  | { ok: true; customerId: string | null }
  | { ok: false; reason: string; retryable: boolean };

async function sendOne(
  row: PendingCrmLead,
  deps: { crm: CrmConfig; bucket: CrmRetryBucket; fetchImpl: typeof fetch },
): Promise<SendResult> {
  try {
    const attachments =
      crmTypeFor(row.form_key) === 'quote' ? await loadAttachments(deps.bucket, row) : [];
    const outcome = await pushLead(deps.crm, buildCrmForm(row, attachments), deps.fetchImpl);
    return outcome.ok
      ? { ok: true, customerId: outcome.customerId }
      : { ok: false, reason: outcome.reason, retryable: outcome.retryable };
  } catch (err) {
    if (err instanceof MissingAttachment) {
      // R2에서 사라진 파일은 기다린다고 돌아오지 않는다.
      return { ok: false, reason: err.message, retryable: false };
    }
    // 여기까지 온 예외는 우리 쪽 버그이거나 R2 장애다. 어느 쪽이든 사유에
    // 고객 데이터가 섞이지 않도록 예외 문구는 로그에만 남기고 DB에는 남기지 않는다.
    console.error('crm retry: 전송 중 예외', err);
    return { ok: false, reason: 'internal_error', retryable: true };
  }
}

async function alert(
  mail: MailConfig,
  row: SubmissionRow,
  attempts: number,
  reason: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const { subject, html } = buildCrmAlertEmail(row, { attempts, error: reason });
    await sendEmail(mail, subject, html, fetchImpl);
  } catch (err) {
    // 알림이 실패해도 재시도 결과 기록은 이미 끝났다. 여기서 던지면 뒤 건들이 굶는다.
    console.error('crm retry: 알림 발송 실패', err);
  }
}
