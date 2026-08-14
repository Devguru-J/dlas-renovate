import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { findForm, type StatusMessages } from '../../../../../../lib/forms/definitions';
import { validateText } from '../../../../../../lib/forms/validate';
import {
  MAX_FILE_BYTES, MAX_FILES, detectFileType, sanitizeFilename, r2Key,
  type AttachmentMeta,
} from '../../../../../../lib/forms/files';
import { FILE_TOKEN_TTL_MS, signFileToken, hashIp } from '../../../../../../lib/forms/token';
import { cf7Response, FALLBACK_MESSAGES } from '../../../../../../lib/forms/cf7';
import {
  insertSubmission, updateEmailStatus, type SubmissionRow,
} from '../../../../../../lib/forms/db';
import { buildEmail, sendEmail, escapeHtml } from '../../../../../../lib/forms/notify';
import { verifyTurnstile } from '../../../../../../lib/forms/turnstile';
import { readEnv, crmConfig } from '../../../../../../lib/forms/env';
import { syncLeadNow } from '../../../../../../lib/forms/crm-retry';
import { waitUntilCtx } from '../../../../../../lib/forms/runtime';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  // 폼이 아직 식별되지 않았을 때 예외가 나면 이 기본값으로 응답한다.
  let unitTag = 'unknown';
  let msg: StatusMessages = FALLBACK_MESSAGES;

  try {
    return await handleFeedback({ request, params, locals }, (tag, m) => {
      unitTag = tag;
      msg = m;
    });
  } catch (err) {
    // 여기까지 새어나온 예외는 설정 누락 등 예측하지 못한 실패다.
    // 4xx/5xx를 내면 CF7 클라이언트가 아무 메시지도 보여주지 않으므로 200으로 응답한다.
    console.error('unhandled error in feedback endpoint', err);
    return cf7Response(unitTag, 'mail_failed', msg.mail_failed);
  }
};

async function handleFeedback(
  {
    request,
    params,
    locals,
  }: { request: Request; params: Partial<Record<string, string>>; locals: unknown },
  onFormIdentified: (unitTag: string, msg: StatusMessages) => void,
): Promise<Response> {
  const env = readEnv(cfEnv as unknown as Record<string, unknown>);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return cf7Response('unknown', 'spam', FALLBACK_MESSAGES.spam);
  }

  const str = (name: string): string | null => {
    const v = form.get(name);
    return typeof v === 'string' ? v : null;
  };
  const strAll = (name: string): string[] =>
    form.getAll(name).filter((v): v is string => typeof v === 'string');

  // 1. 폼 판정. URL의 id와 본문의 _wpcf7이 다르면 조작으로 본다.
  const cf7Id = str('_wpcf7') ?? '';
  const containerPost = str('_wpcf7_container_post') ?? '';
  const def = findForm(cf7Id, containerPost);
  if (!def || def.cf7Id !== params.id) {
    return cf7Response(str('_wpcf7_unit_tag') ?? 'unknown', 'spam', FALLBACK_MESSAGES.spam);
  }
  const unitTag = def.unitTag;
  const msg = def.statusMessages;
  // 폼이 식별된 뒤부터는 바깥 catch도 이 폼의 문구를 쓸 수 있게 알려준다.
  onFormIdentified(unitTag, msg);

  const ip = request.headers.get('cf-connecting-ip');

  // 2. Turnstile — TURNSTILE_ENABLED가 false면(위젯이 페이지에 없음) 검사를 건너뛴다.
  // 켜져 있을 때는 기존과 동일하게 동작한다. readEnv()는 turnstileEnabled와
  // turnstileSecret이 항상 함께 움직이도록 보장한다(활성화 ⇔ secret이 문자열,
  // 비활성화 ⇔ secret이 null). 그래서 secret 자체를 좁히는 것으로 충분하며,
  // 캐스트나 non-null 단언 없이도 빈 시크릿으로 호출될 가능성이 타입상 배제된다.
  const secret = env.turnstileSecret;
  if (secret) {
    const passed = await verifyTurnstile(secret, str('cf-turnstile-response'), ip);
    if (!passed) return cf7Response(unitTag, 'spam', msg.spam);
  }

  // 3. 텍스트 검증
  const text = validateText(def, str, strAll);
  const invalid = text.ok ? [] : [...text.invalid];

  // 4. 파일 검증
  const submissionId = crypto.randomUUID();
  const now = new Date();
  const pending: { n: number; meta: AttachmentMeta; body: ArrayBuffer }[] = [];

  let n = 0;
  for (const field of def.fileFields) {
    const entry = form.get(field);
    const isFile = entry instanceof File && entry.size > 0;

    if (!isFile) {
      if (def.requiredFields.includes(field)) {
        invalid.push({ field, message: def.messages.fileRequired });
      }
      continue;
    }
    if (n >= MAX_FILES) continue;
    if (entry.size > MAX_FILE_BYTES) {
      invalid.push({ field, message: def.messages.fileTooBig });
      continue;
    }

    const body = await entry.arrayBuffer();
    const type = detectFileType(new Uint8Array(body.slice(0, 8)));
    if (!type) {
      invalid.push({ field, message: def.messages.fileType });
      continue;
    }

    n += 1;
    const filename = sanitizeFilename(entry.name);
    pending.push({
      n,
      body,
      meta: {
        n,
        filename,
        size: entry.size,
        content_type: type.mime,
        r2_key: r2Key(submissionId, n, filename, now),
      },
    });
  }

  if (invalid.length > 0) {
    return cf7Response(unitTag, 'validation_failed', msg.validation_failed, invalid);
  }
  if (!text.ok) {
    return cf7Response(unitTag, 'validation_failed', msg.validation_failed, text.invalid);
  }

  // 5. R2 먼저, DB 나중. 반대면 파일 없는 레코드가 생긴다.
  const bucket = (cfEnv as unknown as { FORM_UPLOADS: R2Bucket }).FORM_UPLOADS;
  try {
    for (const p of pending) {
      await bucket.put(p.meta.r2_key, p.body, {
        httpMetadata: { contentType: p.meta.content_type },
      });
    }
  } catch (err) {
    console.error('r2 put failed', err);
    return cf7Response(unitTag, 'mail_failed', msg.mail_failed);
  }

  const row: SubmissionRow = {
    id: submissionId,
    form_key: def.key,
    form_subject: def.subject, // 클라이언트의 your-subject는 신뢰하지 않는다
    name: text.data.name,
    phone: text.data.phone,
    car: text.data.car,
    methods: text.data.methods,
    pay_period: text.data.payPeriod,
    message: text.data.message,
    ref: text.data.ref,
    referer_page: text.data.refererPage,
    source_page: request.headers.get('referer'),
    attachments: pending.map((p) => p.meta),
    email_sent_at: null,
    email_error: null,
    ip_hash: ip ? await hashIp(env.fileTokenSecret, ip) : null,
    user_agent: request.headers.get('user-agent'),
  };

  const supabase = { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey };
  try {
    await insertSubmission(supabase, row);
  } catch (err) {
    console.error('supabase insert failed', err);
    // 저장에는 실패했지만 고객의 문의 자체는 잃지 않도록 담당자에게라도 알린다.
    // 알림이 또 실패해도 응답은 바뀌지 않는다 — 이 블록은 밖으로 예외를 내보내지 않는다.
    try {
      // 서명 링크는 레코드가 있어야 동작한다(다운로드 엔드포인트가 attachments를
      // Supabase에서 조회한다). 저장이 실패한 지금은 링크가 404가 되므로 아예 넣지 않고,
      // 대신 R2 키를 평문으로 적어 담당자가 대시보드에서 직접 받을 수 있게 한다.
      const base = buildEmail(row, []);
      const fileNote =
        pending.length > 0
          ? `<p style="margin:0 0 8px">첨부파일은 R2에 업로드되어 있으나 다운로드 링크는 발급되지 않았습니다. R2 대시보드에서 아래 키로 내려받아 주세요.</p><ul style="margin:0 0 8px;padding-left:18px">${pending
              .map(
                (p) =>
                  `<li>${escapeHtml(p.meta.filename)} — <code>${escapeHtml(p.meta.r2_key)}</code></li>`,
              )
              .join('')}</ul>`
          : '';
      const notice = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;font-size:14px;color:#222;border:2px solid #c00;padding:12px;margin-bottom:16px">
<h2 style="font-size:16px;margin:0 0 8px;color:#c00">[DB저장실패] 이 제출은 데이터베이스에 저장되지 않았습니다.</h2>
<p style="margin:0 0 8px">아래 내용을 수동으로 기록하고 고객에게 연락해 주세요. 고객 화면에는 실패 안내가 표시되어 재제출할 수 있습니다.</p>
${fileNote}</div>`;
      await sendEmail(
        { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
        `[DB저장실패] ${base.subject}`,
        notice + base.html,
      );
    } catch (mailErr) {
      console.error('db failure notification email failed', mailErr);
    }
    return cf7Response(unitTag, 'mail_failed', msg.mail_failed);
  }

  // 6. 이메일. insertSubmission이 성공한 뒤부터는 이 블록 안에서 무엇이 실패해도
  // 응답은 반드시 mail_sent로 유지한다 — 이미 저장된 리드를 실패로 보고하면
  // 고객이 중복 제출하거나 포기하게 된다. 서명 링크 생성·이메일 본문 구성도
  // sendEmail과 같은 try 안에 둔다.
  try {
    const exp = Date.now() + FILE_TOKEN_TTL_MS;
    const links = await Promise.all(
      pending.map(async (p) => ({
        filename: p.meta.filename,
        url: `${env.siteOrigin}/api/file/${submissionId}/${p.n}?t=${await signFileToken(
          env.fileTokenSecret,
          submissionId,
          p.n,
          exp,
        )}`,
      })),
    );

    const { subject, html } = buildEmail(row, links);
    await sendEmail(
      { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
      subject,
      html,
    );
    await updateEmailStatus(supabase, submissionId, {
      email_sent_at: new Date().toISOString(),
      email_error: null,
    });
  } catch (err) {
    // 알림 실패는 기록만 남기고 성공 응답을 유지한다. 리드를 잃는 것보다 낫다.
    console.error('email failed', err);
    await updateEmailStatus(supabase, submissionId, {
      email_sent_at: null,
      email_error: String(err).slice(0, 500),
    });
  }

  // 7. 차선생 CRM 전송. 계약 정본은 docs/crm-lead-integration.md 다.
  //
  // 시크릿이 없으면 crmConfig가 null을 주고, 그러면 시도조차 하지 않는다 — 상대측
  // 엔드포인트가 배포되기 전에는 이것이 곧 꺼짐 스위치다(재시도 예산도 소모되지 않는다).
  //
  // 응답을 붙잡지 않는다. CRM이 느리다고 고객이 기다릴 이유가 없고, 여기서 놓친 건은
  // 크론(src/worker.ts)이 같은 submissionId로 이어받는다. 첨부는 방금 R2에 올린
  // 바이트가 아직 메모리에 있으므로 다시 내려받지 않고 그대로 넘긴다.
  //
  // 이 블록 전체를 try로 감싼다. 여기서 무엇이 터지든 이미 저장된 리드를 실패로
  // 보고할 수는 없다. 이메일 블록과 같은 규율이다.
  try {
    const crm = crmConfig(env);
    if (crm) {
      // 워커에서는 응답 후에 마저 돌리고, ctx가 없는 환경에서는 기다린다.
      const ctx = waitUntilCtx(locals);
      const task = syncLeadNow(
        {
          supabase,
          crm,
          mail: { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
        },
        row,
        pending.map((p) => ({
          n: p.n,
          filename: p.meta.filename,
          contentType: p.meta.content_type,
          body: p.body,
        })),
      );

      if (ctx) ctx.waitUntil(task);
      else await task;
    }
  } catch (err) {
    console.error('crm 전송 배선 실패', err);
  }

  return cf7Response(unitTag, 'mail_sent', msg.mail_sent);
}
