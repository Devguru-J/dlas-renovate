import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import {
  findForm, orderInvalidFields, type StatusMessages,
} from '../../../../../../lib/forms/definitions';
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
import { dedupeKey } from '../../../../../../lib/forms/dedupe';
import {
  checkRateLimit, readRateLimitBindings, shouldAlert,
} from '../../../../../../lib/forms/ratelimit';
import { isIpOverDailyCap } from '../../../../../../lib/forms/ipcap';
import { ipBucket } from '../../../../../../lib/forms/ip';
import { buildEmail, sendEmail, escapeHtml } from '../../../../../../lib/forms/notify';
import { verifyTurnstile } from '../../../../../../lib/forms/turnstile';
import { readEnv, crmConfig } from '../../../../../../lib/forms/env';
import { syncLeadNow } from '../../../../../../lib/forms/crm-retry';
import { waitUntilCtx } from '../../../../../../lib/forms/runtime';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  // 폼이 아직 식별되지 않았을 때 예외가 나면 이 기본값으로 응답한다.
  let unitTag = 'unknown';
  let cf7Id = params.id ?? '';
  let msg: StatusMessages = FALLBACK_MESSAGES;

  try {
    return await handleFeedback({ request, params, locals }, (tag, id, m) => {
      unitTag = tag;
      cf7Id = id;
      msg = m;
    });
  } catch (err) {
    // 여기까지 새어나온 예외는 설정 누락 등 예측하지 못한 실패다.
    // 4xx/5xx를 내면 CF7 클라이언트가 아무 메시지도 보여주지 않으므로 200으로 응답한다.
    console.error('unhandled error in feedback endpoint', err);
    return cf7Response(unitTag, cf7Id, 'mail_failed', msg.mail_failed);
  }
};

async function handleFeedback(
  {
    request,
    params,
    locals,
  }: { request: Request; params: Partial<Record<string, string>>; locals: unknown },
  onFormIdentified: (unitTag: string, cf7Id: string, msg: StatusMessages) => void,
): Promise<Response> {
  const env = readEnv(cfEnv as unknown as Record<string, unknown>);
  const ip = request.headers.get('cf-connecting-ip');

  // 0. 속도 제한. 본문을 파싱하기 전에 본다 — 여기서 흘려보내야 첨부 10MB짜리
  // multipart 파싱이나 Supabase 왕복 같은 비싼 일을 공격자가 시킬 수 없다.
  // 이 시점엔 아직 폼을 모르므로(_wpcf7이 본문에 있다) 폴백 문구를 쓴다.
  // CF7 클라이언트는 응답의 status·message만 읽고 into로 폼을 찾지 않으므로,
  // unitTag가 'unknown'이어도 화면에는 정상적으로 문구가 뜬다.
  const rlBindings = readRateLimitBindings(cfEnv as unknown as Record<string, unknown>);
  const limits = await checkRateLimit(rlBindings, ip);
  if (!limits.ok) {
    console.warn('rate limited', { scope: limits.scope });

    // 전역 리밋이 걸렸다는 건 폼이 모든 방문자에게 죽었다는 뜻이다. 리드로 먹고사는
    // 사이트에서 이게 조용히 일어나면 매출이 새는 걸 아무도 모른다. 사람에게 알린다.
    // RL_ALERT가 1분에 한 번만 통과시키므로 공격 중에도 메일 폭탄이 되지 않고,
    // 알림 실패가 응답을 바꾸지 않도록 통째로 감싼다.
    if (limits.scope === 'global') {
      const alerting = (async () => {
        try {
          if (!(await shouldAlert(rlBindings))) return;
          await sendEmail(
            { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
            '[긴급] dlas 컨택폼 전역 속도 제한 발동 — 폼이 막히고 있습니다',
            `<p style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif">
전역 속도 제한(1분 600건)에 걸려 <strong>모든 방문자</strong>의 문의가 거부되고 있습니다.
공격이거나 비정상 트래픽입니다. Cloudflare 대시보드에서 트래픽을 확인해 주세요.</p>
<p style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif">
이 알림은 1분에 한 번만 발송됩니다.</p>`,
          );
        } catch (err) {
          console.error('전역 리밋 알림 발송 실패', err);
        }
      })();
      const ctx = waitUntilCtx(locals);
      if (ctx) ctx.waitUntil(alerting);
    }

    return cf7Response('unknown', params.id ?? '', 'spam', FALLBACK_MESSAGES.spam);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return cf7Response('unknown', params.id ?? '', 'spam', FALLBACK_MESSAGES.spam);
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
    return cf7Response(
      str('_wpcf7_unit_tag') ?? 'unknown',
      params.id ?? '',
      'spam',
      FALLBACK_MESSAGES.spam,
    );
  }
  const unitTag = def.unitTag;
  const msg = def.statusMessages;
  // 폼이 식별된 뒤부터는 바깥 catch도 이 폼의 문구를 쓸 수 있게 알려준다.
  onFormIdentified(unitTag, def.cf7Id, msg);

  // 2. Turnstile — TURNSTILE_ENABLED가 false면(위젯이 페이지에 없음) 검사를 건너뛴다.
  // 켜져 있을 때는 기존과 동일하게 동작한다. readEnv()는 turnstileEnabled와
  // turnstileSecret이 항상 함께 움직이도록 보장한다(활성화 ⇔ secret이 문자열,
  // 비활성화 ⇔ secret이 null). 그래서 secret 자체를 좁히는 것으로 충분하며,
  // 캐스트나 non-null 단언 없이도 빈 시크릿으로 호출될 가능성이 타입상 배제된다.
  const secret = env.turnstileSecret;
  if (secret) {
    const passed = await verifyTurnstile(secret, str('cf-turnstile-response'), ip);
    if (!passed) return cf7Response(unitTag, def.cf7Id, 'spam', msg.spam);
  }

  // 3. 텍스트 검증.
  //
  // 원본은 텍스트 검증을 통과한 뒤에야 업로드 파일을 검사한다(WPCF7_Submission이
  // validate() 실패 시 곧바로 반환하고, unship_uploaded_files()는 그 뒤에 돈다).
  // 그래서 이름이 비어 있으면 첨부가 없어도 file-71 에러는 나오지 않는다.
  // 원본 응답과 어긋나지 않도록 같은 순서로 처리한다.
  const text = validateText(def, str, strAll);
  if (!text.ok) {
    return cf7Response(
      unitTag,
      def.cf7Id,
      'validation_failed',
      msg.validation_failed,
      orderInvalidFields(def, [...text.invalid]),
    );
  }

  // 4. 파일 검증
  const invalid: { field: string; message: string }[] = [];
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
    return cf7Response(
      unitTag,
      def.cf7Id,
      'validation_failed',
      msg.validation_failed,
      orderInvalidFields(def, invalid),
    );
  }

  // 4.5. IP별 일일 누적 상한.
  //
  // 버스트 리밋(0단계)은 순간 속도만 본다. 그 한계선을 파악하고 3초에 한 건씩 꾸준히
  // 던지는 저속 공격은 통과하므로, "지난 24시간 동안 이 IP가 만든 레코드 수"로 한 번 더 센다.
  //
  // 여기 두는 이유가 있다. 검증을 통과한 요청에만 돌리므로 빈 값 플러딩으로는 이 쿼리를
  // 유발할 수 없고(=DoS 증폭 경로가 아님), R2 업로드·DB 쓰기보다 앞서므로 상한을 넘긴
  // 요청은 저장소를 건드리지 못한다. 조회에 실패하면 통과시킨다(fail-open) —
  // Supabase가 흔들린다고 정상 고객의 문의를 막을 수는 없다.
  // ipBucket으로 정규화한 값을 해시한다. 전체 IPv6 주소를 쓰면 공격자가 자기 /64 안에서
  // 주소만 바꿔가며 매번 새 ip_hash를 얻어 일일 상한을 무한히 리셋할 수 있다.
  const ipHash = ip ? await hashIp(env.ipHashSalt, ipBucket(ip)) : null;
  const supabase = { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey };
  if (await isIpOverDailyCap(supabase, ipHash, now)) {
    console.warn('daily ip cap exceeded', { form: def.key });
    return cf7Response(unitTag, def.cf7Id, 'spam', msg.spam);
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
    return cf7Response(unitTag, def.cf7Id, 'mail_failed', msg.mail_failed);
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
    ip_hash: ipHash,
    user_agent: request.headers.get('user-agent'),
    dedupe_key: '',
  };
  row.dedupe_key = await dedupeKey(row, now);

  let inserted: 'inserted' | 'duplicate';
  try {
    inserted = await insertSubmission(supabase, row);
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
    return cf7Response(unitTag, def.cf7Id, 'mail_failed', msg.mail_failed);
  }

  // 5.5. 중복 제출. 전송 중 버튼을 연타하면 같은 내용이 거의 동시에 여러 번 도착하고,
  // dedupe_key 유니크 인덱스가 두 번째부터를 막는다. 고객 입장에서는 문의가 접수된 것이
  // 맞으므로 실패가 아니라 평소와 같은 성공 문구로 응답한다. 대신 알림 메일·CRM 전송은
  // 하지 않는다 — 담당자에게 같은 리드를 두 번 보내지 않기 위해서다.
  // 방금 R2에 올린 첨부는 가리키는 레코드가 없으니 지운다(안 지우면 보이지 않는 쓰레기가 된다).
  if (inserted === 'duplicate') {
    console.log('duplicate submission ignored', { form: def.key });
    for (const p of pending) {
      try {
        await bucket.delete(p.meta.r2_key);
      } catch (err) {
        console.error('r2 delete failed for duplicate submission', err);
      }
    }
    return cf7Response(unitTag, def.cf7Id, 'mail_sent', msg.mail_sent);
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

  return cf7Response(unitTag, def.cf7Id, 'mail_sent', msg.mail_sent);
}
