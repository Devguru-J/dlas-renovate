import type { SubmissionRow } from './db';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tableRow(label: string, value: string): string {
  return `<tr><th align="left" style="padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;color:#666">${escapeHtml(
    label,
  )}</th><td style="padding:6px 0">${value}</td></tr>`;
}

export function buildEmail(
  row: SubmissionRow,
  fileLinks: { filename: string; url: string }[],
): { subject: string; html: string } {
  const subject = `[${row.form_subject}] ${row.name} ${row.phone}`;

  const rows: string[] = [
    tableRow('성함', escapeHtml(row.name)),
    tableRow('연락처', escapeHtml(row.phone)),
  ];
  if (row.car) rows.push(tableRow('차종', escapeHtml(row.car)));
  if (row.methods.length > 0) rows.push(tableRow('구매방식', escapeHtml(row.methods.join(', '))));
  if (row.pay_period.length > 0) rows.push(tableRow('시기', escapeHtml(row.pay_period.join(', '))));
  if (row.message) {
    rows.push(tableRow('문의사항', escapeHtml(row.message).replace(/\n/g, '<br />')));
  }
  if (fileLinks.length > 0) {
    const links = fileLinks
      .map((f) => `<a href="${escapeHtml(f.url)}">${escapeHtml(f.filename)}</a>`)
      .join('<br />');
    rows.push(tableRow('첨부파일', `${links}<br /><small style="color:#999">링크는 7일 후 만료됩니다.</small>`));
  }
  if (row.ref) rows.push(tableRow('마케팅경로', escapeHtml(row.ref)));
  if (row.referer_page) rows.push(tableRow('이전페이지', escapeHtml(row.referer_page)));
  if (row.source_page) rows.push(tableRow('제출페이지', escapeHtml(row.source_page)));

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;font-size:14px;color:#222">
<h2 style="font-size:16px;margin:0 0 16px">${escapeHtml(row.form_subject)}</h2>
<table cellpadding="0" cellspacing="0">${rows.join('')}</table>
<p style="margin-top:24px;color:#999;font-size:12px">제출 ID: ${escapeHtml(row.id)}</p>
</div>`;

  return { subject, html };
}

/**
 * CRM 전송을 포기했을 때 담당자에게 보내는 알림.
 *
 * 재시도 상한을 소진했거나(장기 장애) 재시도해도 소용없는 응답(400·401·413·415)을
 * 받은 순간 **한 번만** 보낸다. 크론이 도는 족족 보내면 알림이 무뎌져서 아무도 안 본다.
 *
 * 리드 자체는 Supabase에 남아 있으므로 이 메일은 "데이터를 잃었다"가 아니라
 * "자동 등록이 안 됐으니 CRM에 손으로 넣어 달라"는 뜻이다. 그 구분을 본문에 명시한다.
 *
 * error에는 crm_error 컬럼과 같은 값(상태코드 + 기계식 코드)이 들어온다. 상대측 응답
 * 본문이 아니므로 고객 PII가 섞일 경로는 없지만, 담당자 메일함에 그대로 렌더되는 값이라
 * 이스케이프는 거른다.
 */
export function buildCrmAlertEmail(
  row: SubmissionRow,
  info: { attempts: number; error: string | null },
): { subject: string; html: string } {
  const subject = `[CRM전송실패] ${row.form_subject} ${row.name} ${row.phone}`;

  const rows = [
    tableRow('성함', escapeHtml(row.name)),
    tableRow('연락처', escapeHtml(row.phone)),
    tableRow('폼', escapeHtml(row.form_subject)),
    tableRow('제출 ID', `<code>${escapeHtml(row.id)}</code>`),
    tableRow('시도 횟수', `${info.attempts}회`),
    tableRow('마지막 사유', escapeHtml(info.error ?? '(사유 없음)')),
  ];

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;font-size:14px;color:#222">
<div style="border:2px solid #c00;padding:12px;margin-bottom:16px">
<h2 style="font-size:16px;margin:0 0 8px;color:#c00">차선생 CRM 자동 등록에 실패했습니다.</h2>
<p style="margin:0">이 리드는 <strong>Supabase에 정상 저장되어 있고 고객에게도 정상 접수로 응답</strong>됐습니다. 잃어버린 데이터는 없습니다. 다만 CRM 자동 등록만 실패했으므로 <strong>CRM에 직접 등록</strong>해 주세요. 자동 재시도는 더 이상 하지 않습니다.</p>
</div>
<table cellpadding="0" cellspacing="0">${rows.join('')}</table>
</div>`;

  return { subject, html };
}

export interface MailConfig {
  apiKey: string;
  from: string;
  to: string[];
}

export async function sendEmail(
  cfg: MailConfig,
  subject: string,
  html: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, html }),
  });

  if (!res.ok) {
    throw new Error(`resend failed: ${res.status} ${await res.text()}`);
  }
}
