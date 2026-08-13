import type { CrmConfig } from './crm';

export interface FormsEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  // Turnstile이 꺼져 있으면(turnstileEnabled === false) 시크릿이 없을 수 있으므로
  // null을 허용한다. 이 타입 덕분에 verifyTurnstile을 빈 문자열로 호출하는 실수가
  // 컴파일 타임에 걸러진다 — 호출부는 반드시 null 체크(=enabled 체크)를 거쳐야 한다.
  turnstileEnabled: boolean;
  turnstileSecret: string | null;
  resendApiKey: string;
  notifyTo: string[];
  notifyFrom: string;
  fileTokenSecret: string;
  siteOrigin: string;
  // CRM 연동은 선택이다. 상대측 시크릿이 오기 전에도 사이트는 그대로 동작해야 하므로
  // CRM_HOMEPAGE_SECRET이 없으면 "실패"가 아니라 "전송 생략"이다.
  // turnstileSecret과 같은 방식으로 string | null을 쓴다 — as 캐스트 없이
  // crmConfig()의 null 반환을 좁혀야만 pushLead를 호출할 수 있게 만든다.
  crmSecret: string | null;
  /** 스테이징 CRM으로 돌릴 수 있도록 변수로 뺀다. 기본값은 계약서의 운영 URL. */
  crmEndpoint: string;
}

/**
 * 첨부파일 다운로드 엔드포인트가 실제로 쓰는 변수만 담는다.
 * 메일(RESEND/NOTIFY)이나 Turnstile 설정이 틀렸다고 해서 다운로드까지 죽으면 안 된다.
 */
export interface FileEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  fileTokenSecret: string;
}

function required(source: Record<string, unknown>, name: string): string {
  const v = source[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`환경변수 ${name}가 설정되어 있지 않습니다.`);
  }
  return v.trim();
}

// 부재/공백 → true(기본 활성화). "false"/"true"(대소문자, 공백 무시) 외의 값은 예외.
// 기본값을 반드시 활성화로 두는 이유: 배포 시 변수를 깜빡 빠뜨려도 봇 방어가
// 조용히 꺼지면 안 되기 때문이다.
function readTurnstileEnabled(source: Record<string, unknown>): boolean {
  const raw = source['TURNSTILE_ENABLED'];
  if (typeof raw !== 'string' || raw.trim() === '') return true;
  const v = raw.trim().toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  throw new Error(
    `환경변수 TURNSTILE_ENABLED 값이 올바르지 않습니다. "true" 또는 "false"만 허용됩니다 (받은 값: ${raw}).`,
  );
}

/** 없거나 공백이면 null. required와 달리 던지지 않는다. */
function optional(source: Record<string, unknown>, name: string): string | null {
  const v = source[name];
  if (typeof v !== 'string' || v.trim() === '') return null;
  return v.trim();
}

/** 계약서(docs/crm-lead-integration.md)의 운영 엔드포인트. */
export const DEFAULT_CRM_ENDPOINT = 'https://crm.mrcha.app/api/homepage/lead';

/**
 * 시크릿이 없으면 null이다. 호출부는 이 null을 좁혀야만 pushLead에 도달할 수 있어,
 * 시크릿 없이 CRM을 호출하는 코드는 애초에 타입으로 표현되지 않는다.
 */
export function crmConfig(env: {
  crmSecret: string | null;
  crmEndpoint: string;
}): CrmConfig | null {
  if (env.crmSecret === null) return null;
  return { endpoint: env.crmEndpoint, secret: env.crmSecret };
}

export function readFileEnv(source: Record<string, unknown>): FileEnv {
  return {
    supabaseUrl: required(source, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(source, 'SUPABASE_SERVICE_ROLE_KEY'),
    fileTokenSecret: required(source, 'FILE_TOKEN_SECRET'),
  };
}

export function readEnv(source: Record<string, unknown>): FormsEnv {
  const turnstileEnabled = readTurnstileEnabled(source);
  return {
    supabaseUrl: required(source, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(source, 'SUPABASE_SERVICE_ROLE_KEY'),
    turnstileEnabled,
    turnstileSecret: turnstileEnabled ? required(source, 'TURNSTILE_SECRET') : null,
    resendApiKey: required(source, 'RESEND_API_KEY'),
    notifyTo: required(source, 'NOTIFY_TO')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    notifyFrom: required(source, 'NOTIFY_FROM'),
    fileTokenSecret: required(source, 'FILE_TOKEN_SECRET'),
    siteOrigin: required(source, 'PUBLIC_SITE_ORIGIN').replace(/\/+$/, ''),
    crmSecret: optional(source, 'CRM_HOMEPAGE_SECRET'),
    crmEndpoint: optional(source, 'CRM_ENDPOINT') ?? DEFAULT_CRM_ENDPOINT,
  };
}
