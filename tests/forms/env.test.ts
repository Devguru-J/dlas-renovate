import { describe, it, expect } from 'vitest';
import { readEnv, readFileEnv } from '../../src/lib/forms/env';

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

  describe('TURNSTILE_ENABLED', () => {
    it('변수가 없으면 기본적으로 활성화된다', () => {
      const { TURNSTILE_ENABLED, ...rest } = full as Record<string, unknown>;
      const env = readEnv(rest);
      expect(env.turnstileEnabled).toBe(true);
      expect(env.turnstileSecret).toBe('t');
    });

    it('빈 문자열/공백이면 기본적으로 활성화된다', () => {
      expect(readEnv({ ...full, TURNSTILE_ENABLED: '' }).turnstileEnabled).toBe(true);
      expect(readEnv({ ...full, TURNSTILE_ENABLED: '   ' }).turnstileEnabled).toBe(true);
    });

    it('"false"(대소문자, 공백 무시)면 비활성화된다', () => {
      expect(readEnv({ ...full, TURNSTILE_ENABLED: 'false' }).turnstileEnabled).toBe(false);
      expect(readEnv({ ...full, TURNSTILE_ENABLED: 'FALSE' }).turnstileEnabled).toBe(false);
      expect(readEnv({ ...full, TURNSTILE_ENABLED: '  False  ' }).turnstileEnabled).toBe(false);
    });

    it('"true"(대소문자, 공백 무시)면 활성화된다', () => {
      expect(readEnv({ ...full, TURNSTILE_ENABLED: 'true' }).turnstileEnabled).toBe(true);
      expect(readEnv({ ...full, TURNSTILE_ENABLED: 'TRUE' }).turnstileEnabled).toBe(true);
      expect(readEnv({ ...full, TURNSTILE_ENABLED: '  True  ' }).turnstileEnabled).toBe(true);
    });

    it('true/false 외의 값이면 변수 이름과 허용값을 알려주며 예외를 던진다', () => {
      expect(() => readEnv({ ...full, TURNSTILE_ENABLED: 'yes' }))
        .toThrow(/TURNSTILE_ENABLED/);
      expect(() => readEnv({ ...full, TURNSTILE_ENABLED: 'yes' }))
        .toThrow(/true/);
      expect(() => readEnv({ ...full, TURNSTILE_ENABLED: 'yes' }))
        .toThrow(/false/);
    });

    it('활성화 상태에서 TURNSTILE_SECRET이 없으면 예외를 던진다', () => {
      const { TURNSTILE_SECRET, ...rest } = full;
      expect(() => readEnv({ ...rest, TURNSTILE_ENABLED: 'true' })).toThrow(/TURNSTILE_SECRET/);
    });

    it('활성화 상태에서 TURNSTILE_SECRET이 빈 문자열이면 예외를 던진다', () => {
      expect(() => readEnv({ ...full, TURNSTILE_ENABLED: 'true', TURNSTILE_SECRET: '' }))
        .toThrow(/TURNSTILE_SECRET/);
    });

    it('비활성화 상태에서는 TURNSTILE_SECRET이 없어도 된다', () => {
      const { TURNSTILE_SECRET, ...rest } = full;
      const env = readEnv({ ...rest, TURNSTILE_ENABLED: 'false' });
      expect(env.turnstileEnabled).toBe(false);
      expect(env.turnstileSecret).toBeNull();
    });

    it('비활성화 상태에서는 TURNSTILE_SECRET이 빈 문자열이어도 된다', () => {
      const env = readEnv({ ...full, TURNSTILE_ENABLED: 'false', TURNSTILE_SECRET: '' });
      expect(env.turnstileEnabled).toBe(false);
      expect(env.turnstileSecret).toBeNull();
    });

    it('비활성화 상태에서 TURNSTILE_SECRET이 존재해도 무시하고 null로 만든다', () => {
      const env = readEnv({ ...full, TURNSTILE_ENABLED: 'false' });
      expect(env.turnstileSecret).toBeNull();
    });
  });
});

describe('readFileEnv', () => {
  const fileOnly = {
    SUPABASE_URL: 'https://p.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    FILE_TOKEN_SECRET: 's',
  };

  it('세 개의 변수만 읽어 반환한다', () => {
    expect(readFileEnv(fileOnly)).toEqual({
      supabaseUrl: 'https://p.supabase.co',
      supabaseServiceRoleKey: 'k',
      fileTokenSecret: 's',
    });
  });

  it('메일·Turnstile 설정이 하나도 없어도 성공한다', () => {
    expect(() => readFileEnv(fileOnly)).not.toThrow();
  });

  it('메일 설정이 비어 있거나 TURNSTILE_ENABLED가 잘못돼도 영향을 받지 않는다', () => {
    const env = readFileEnv({
      ...fileOnly,
      RESEND_API_KEY: '',
      NOTIFY_TO: '',
      NOTIFY_FROM: '',
      TURNSTILE_ENABLED: 'yes',
    });
    expect(env.fileTokenSecret).toBe('s');
  });

  it('SUPABASE_URL이 없으면 이름과 함께 예외를 던진다', () => {
    const { SUPABASE_URL, ...rest } = fileOnly;
    expect(() => readFileEnv(rest)).toThrow(/SUPABASE_URL/);
  });

  it('SUPABASE_SERVICE_ROLE_KEY가 없으면 이름과 함께 예외를 던진다', () => {
    const { SUPABASE_SERVICE_ROLE_KEY, ...rest } = fileOnly;
    expect(() => readFileEnv(rest)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('FILE_TOKEN_SECRET이 없으면 이름과 함께 예외를 던진다', () => {
    const { FILE_TOKEN_SECRET, ...rest } = fileOnly;
    expect(() => readFileEnv(rest)).toThrow(/FILE_TOKEN_SECRET/);
  });

  it('빈 문자열도 누락으로 본다', () => {
    expect(() => readFileEnv({ ...fileOnly, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL/);
    expect(() => readFileEnv({ ...fileOnly, SUPABASE_SERVICE_ROLE_KEY: '   ' }))
      .toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => readFileEnv({ ...fileOnly, FILE_TOKEN_SECRET: '' })).toThrow(/FILE_TOKEN_SECRET/);
  });
});
