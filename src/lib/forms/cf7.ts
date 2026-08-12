export type Cf7Status = 'mail_sent' | 'mail_failed' | 'validation_failed' | 'spam';

/**
 * 폼 판정 자체가 실패해 어떤 폼의 문구를 써야 할지 모를 때만 쓴다.
 * 정상 경로에서는 FormDefinition.statusMessages를 쓴다.
 */
export const FALLBACK_MESSAGES: Record<Cf7Status, string> = {
  mail_sent: '찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다.',
  mail_failed: '발송 중 오류가 발생했습니다. 다시 시도해주세요.',
  validation_failed: '정확하게 입력 부탁드립니다.',
  spam: '메시지를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도해주세요.',
};

/**
 * CF7 6.0.6 클라이언트는 응답의 status, message, invalid_fields만 본다.
 * HTTP 상태는 항상 200이어야 한다. 4xx/5xx면 클라이언트가 fetch 자체를 실패로 처리해
 * 사용자에게 아무 메시지도 보여주지 않는다.
 */
export function cf7Response(
  unitTag: string,
  status: Cf7Status,
  message: string,
  invalidFields: { field: string; message: string }[] = [],
): Response {
  return new Response(
    JSON.stringify({
      into: `#${unitTag}`,
      status,
      message,
      posted_data_hash: '',
      invalid_fields: invalidFields,
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}
