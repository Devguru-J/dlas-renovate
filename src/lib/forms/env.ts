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
  };
}
