import { describe, it, expect } from 'vitest';
import { MAX_FILE_BYTES, detectFileType, sanitizeFilename, r2Key } from '../../src/lib/forms/files';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);

describe('detectFileType', () => {
  it('jpeg/png/pdf를 매직바이트로 판별한다', () => {
    expect(detectFileType(JPEG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(detectFileType(PNG)).toEqual({ ext: 'png', mime: 'image/png' });
    expect(detectFileType(PDF)).toEqual({ ext: 'pdf', mime: 'application/pdf' });
  });

  it('허용하지 않는 형식은 null이다', () => {
    expect(detectFileType(ELF)).toBeNull();
  });

  it('시그니처보다 짧은 입력은 null이다', () => {
    expect(detectFileType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectFileType(new Uint8Array([]))).toBeNull();
  });

  it('최대 크기는 10MB다', () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('sanitizeFilename', () => {
  it('한글 파일명을 유지한다', () => {
    expect(sanitizeFilename('견적서 2026.pdf')).toBe('견적서 2026.pdf');
  });

  it('경로를 제거한다', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\temp\\a.png')).toBe('a.png');
  });

  it('위험한 문자를 밑줄로 바꾼다', () => {
    expect(sanitizeFilename('a<b>c:d|e?f*g.png')).toBe('a_b_c_d_e_f_g.png');
  });

  it('제어문자를 제거한다', () => {
    expect(sanitizeFilename('a\u0000b\nc.png')).toBe('abc.png');
  });

  it('빈 이름은 기본값이 된다', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
  });

  it('확장자를 유지한 채 120자로 자른다', () => {
    const long = 'a'.repeat(300) + '.pdf';
    const out = sanitizeFilename(long);
    expect(out.length).toBe(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('r2Key', () => {
  it('연/월/제출ID/순번-파일명 구조를 만든다', () => {
    const key = r2Key('11111111-2222-3333-4444-555555555555', 1, '견적서.pdf', new Date('2026-08-12T09:00:00Z'));
    expect(key).toBe('submissions/2026/08/11111111-2222-3333-4444-555555555555/1-견적서.pdf');
  });

  it('월을 두 자리로 채운다', () => {
    expect(r2Key('id', 2, 'a.png', new Date('2026-01-05T00:00:00Z')))
      .toBe('submissions/2026/01/id/2-a.png');
  });
});
