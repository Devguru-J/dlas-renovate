export const FILE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 길이가 달라도 조기 반환하지 않는다 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function payload(id: string, n: number, exp: number): string {
  return `${id}/${n}/${exp}`;
}

/** 토큰 형식: `<만료시각ms>.<base64url HMAC>` */
export async function signFileToken(
  secret: string,
  id: string,
  n: number,
  exp: number,
): Promise<string> {
  const sig = await hmac(secret, payload(id, n, exp));
  return `${exp}.${toBase64Url(sig)}`;
}

export async function verifyFileToken(
  secret: string,
  id: string,
  n: number,
  token: string,
  now: number,
): Promise<'ok' | 'expired' | 'invalid'> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return 'invalid';

  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expRaw)) return 'invalid';

  const exp = Number(expRaw);
  const expected = toBase64Url(await hmac(secret, payload(id, n, exp)));
  if (!timingSafeEqual(sig, expected)) return 'invalid';

  // 서명 확인이 끝난 뒤에 만료를 본다. 변조 토큰이 expired로 새어 나가지 않게 한다.
  return exp < now ? 'expired' : 'ok';
}

/** 원본 IP를 저장하지 않기 위해 시크릿을 솔트로 써서 해시만 남긴다 */
export async function hashIp(secret: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:${ip}`));
  return toHex(new Uint8Array(digest));
}
