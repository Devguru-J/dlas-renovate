import { describe, it, expect } from 'vitest';
import { readEnv } from '../../src/lib/forms/env';

const full = {
  SUPABASE_URL: 'https://p.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  TURNSTILE_SECRET: 't',
  RESEND_API_KEY: 'r',
  NOTIFY_TO: 'a@x.com, b@x.com',
  NOTIFY_FROM: 'noreply@x.com',
  FILE_TOKEN_SECRET: 's',
  PUBLIC_SITE_ORIGIN: 'https://dlas.co.kr',
};

describe('readEnv', () => {
  it('NOTIFY_TO를 쉼표로 나눠 배열로 만든다', () => {
    expect(readEnv(full).notifyTo).toEqual(['a@x.com', 'b@x.com']);
  });

  it('빠진 변수를 이름과 함께 알려준다', () => {
    const { FILE_TOKEN_SECRET, ...rest } = full;
    expect(() => readEnv(rest)).toThrow(/FILE_TOKEN_SECRET/);
  });

  it('빈 문자열도 누락으로 본다', () => {
    expect(() => readEnv({ ...full, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
  });

  it('사이트 오리진 끝의 슬래시를 제거한다', () => {
    expect(readEnv({ ...full, PUBLIC_SITE_ORIGIN: 'https://dlas.co.kr/' }).siteOrigin)
      .toBe('https://dlas.co.kr');
  });
});
