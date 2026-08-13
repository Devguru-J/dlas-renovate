export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 2;

/** 원본 폼의 accept 속성과 같은 집합. 확장자가 아니라 매직바이트로 확인한다. */
const SIGNATURES: { ext: string; mime: string; bytes: number[] }[] = [
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'pdf', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

export function detectFileType(head: Uint8Array): { ext: string; mime: string } | null {
  for (const sig of SIGNATURES) {
    if (head.length < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => head[i] === b)) {
      return { ext: sig.ext, mime: sig.mime };
    }
  }
  return null;
}

const MAX_FILENAME = 120;

/**
 * 경로·제어문자·예약문자를 제거한다. 한글은 그대로 둔다.
 * R2 키에 들어가므로 슬래시가 남으면 안 된다.
 */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[\u0000-\u001f\u007f]/g, '');
  const lastSlash = Math.max(out.lastIndexOf('/'), out.lastIndexOf('\\'));
  if (lastSlash >= 0) out = out.slice(lastSlash + 1);
  out = out.replace(/[<>:"|?*]/g, '_').trim();
  if (out === '' || out === '.' || out === '..') return 'file';

  if (out.length > MAX_FILENAME) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 ? out.slice(dot) : '';
    out = out.slice(0, MAX_FILENAME - ext.length) + ext;
  }
  return out;
}

export function r2Key(id: string, n: number, filename: string, at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `submissions/${y}/${m}/${id}/${n}-${filename}`;
}

export interface AttachmentMeta {
  n: number;
  filename: string;
  size: number;
  content_type: string;
  r2_key: string;
}
