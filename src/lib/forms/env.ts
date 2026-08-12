export interface FormsEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  turnstileSecret: string;
  resendApiKey: string;
  notifyTo: string[];
  notifyFrom: string;
  fileTokenSecret: string;
  siteOrigin: string;
}

function required(source: Record<string, unknown>, name: string): string {
  const v = source[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`환경변수 ${name}가 설정되어 있지 않습니다.`);
  }
  return v.trim();
}

export function readEnv(source: Record<string, unknown>): FormsEnv {
  return {
    supabaseUrl: required(source, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(source, 'SUPABASE_SERVICE_ROLE_KEY'),
    turnstileSecret: required(source, 'TURNSTILE_SECRET'),
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
