import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { findForm } from '../../../../../../lib/forms/definitions';
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
import { buildEmail, sendEmail } from '../../../../../../lib/forms/notify';
import { verifyTurnstile } from '../../../../../../lib/forms/turnstile';
import { readEnv } from '../../../../../../lib/forms/env';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
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

  const ip = request.headers.get('cf-connecting-ip');

  // 2. Turnstile
  const passed = await verifyTurnstile(env.turnstileSecret, str('cf-turnstile-response'), ip);
  if (!passed) return cf7Response(unitTag, 'spam', msg.spam);

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
    return cf7Response(unitTag, 'mail_failed', msg.mail_failed);
  }

  // 6. 이메일. 여기서 실패해도 고객에게는 성공으로 응답한다.
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
  try {
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

  return cf7Response(unitTag, 'mail_sent', msg.mail_sent);
};
