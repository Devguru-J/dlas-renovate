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
