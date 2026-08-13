export type FormKey =
  | 'analysis'
  | 'consulting-new-car'
  | 'consulting-used-car'
  | 'consulting-detailing';

/**
 * 에러 문구. CF7 기본값이 아니라 사이트가 커스터마이즈한 값이라 폼마다 다르다.
 * 정본은 public/wp-json/contact-form-7/v1/contact-forms/{id}/feedback/schema 다.
 */
export interface FormMessages {
  required: string;
  tooLong: string;
  tel: string;
  telShort: string;
  notEnum: string;
  fileRequired: string;
  fileType: string;
  fileTooBig: string;
}

/**
 * .wpcf7-response-output에 뜨는 상태 문구.
 * 원본 WordPress DB의 wp_postmeta._messages에서 가져온 값이다
 * (mail_sent_ok / mail_sent_ng / validation_error / spam).
 */
export interface StatusMessages {
  mail_sent: string;
  mail_failed: string;
  validation_failed: string;
  spam: string;
}

export interface FormDefinition {
  /** DB의 form_key 컬럼에 저장되는 값 */
  key: FormKey;
  /** CF7 히든 필드 _wpcf7 */
  cf7Id: string;
  /** CF7 히든 필드 _wpcf7_container_post */
  containerPost: string;
  /** CF7 히든 필드 _wpcf7_unit_tag. 응답 into 값을 만드는 데 쓴다 */
  unitTag: string;
  /** DB의 form_subject. 클라이언트가 보낸 your-subject는 무시하고 이 값을 쓴다 */
  subject: string;
  /** 이 폼에서 연락처를 담는 필드 이름 */
  phoneField: 'your-phone' | 'your-telephone';
  /** SWV minlength 규칙. detailing에는 없다 */
  phoneMinLength: number | null;
  /** 비어 있으면 validation_failed를 내는 필드들. 체크박스는 `[]`를 포함한 전송 이름이다 */
  requiredFields: string[];
  /** your-method[]로 허용되는 값 */
  methodValues: string[];
  /** your-pay[]로 허용되는 값 */
  payValues: string[];
  /** 이 폼의 마케팅 유입 히든 필드 이름 */
  refField: 'dl_ref' | 'it_ref';
  /** 첨부 파일 필드. 없으면 빈 배열 */
  fileFields: string[];
  messages: FormMessages;
  statusMessages: StatusMessages;
}

const PURCHASE_METHODS = ['리스', '장기렌트', '할부', '현금'];
const PURCHASE_TIMING = ['이번 달', '다음 달', '3개월 이내', '미정'];

const TOO_LONG = '내용이 너무 깁니다.';
const NOT_ENUM = '이 입력란을 통해 정의되지 않은 값이 제출되었습니다.';
const CONSULTING_MESSAGES: FormMessages = {
  required: '정확하게 입력 부탁드립니다.',
  tooLong: TOO_LONG,
  tel: '정확한 휴대폰 번호를 입력해주세요.',
  telShort: '정확한 휴대폰 번호를 입력해주세요.',
  notEnum: NOT_ENUM,
  // consulting 폼에는 첨부가 없어 쓰이지 않는다
  fileRequired: '',
  fileType: '',
  fileTooBig: '',
};

// 583과 631은 mail_sent_ok / mail_sent_ng / spam이 동일하다. validation_error만 다르다.
const CONSULTING_SPAM = '메시지를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도해주세요.';
const CONSULTING_SENT = '찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다.';
const CONSULTING_FAILED = '상담신청 발송 중 오류가 발생했습니다. 다시 시도해주세요.';

export const FORMS: readonly FormDefinition[] = [
  {
    key: 'analysis',
    cf7Id: '584',
    containerPost: '609',
    unitTag: 'wpcf7-f584-p609-o1',
    subject: '견적서 비교분석',
    phoneField: 'your-phone',
    phoneMinLength: 13,
    // file-71은 라벨이 "(선택)"이지만 SWV에 requiredfile 규칙이 있다. 라벨 쪽이 오류다.
    requiredFields: ['your-name', 'your-phone', 'file-71'],
    methodValues: [],
    payValues: [],
    refField: 'dl_ref',
    fileFields: ['file-71', 'file-72'],
    messages: {
      required: '성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다.',
      tooLong: TOO_LONG,
      tel: '전화번호를 정확하게 입력해주세요.',
      telShort: '정확한 휴대폰 번호를 입력해주세요.',
      notEnum: NOT_ENUM,
      fileRequired: '성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다.',
      fileType: '이 유형의 파일을 업로드하도록 허용하지 않습니다.',
      fileTooBig: '파일이 너무 큽니다.',
    },
    statusMessages: {
      mail_sent: '신청완료 되었습니다. 빠른 연락 드리도록 하겠습니다.',
      mail_failed: '발송 중 오류가 발생했습니다. 다시 시도해주세요.',
      validation_failed: '성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다.',
      spam: '안내문를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도하기 바랍니다.',
    },
  },
  {
    key: 'consulting-new-car',
    cf7Id: '583',
    containerPost: '580',
    unitTag: 'wpcf7-f583-p580-o1',
    subject: '신차 상담신청',
    phoneField: 'your-phone',
    phoneMinLength: 13,
    requiredFields: ['your-name', 'your-phone', 'your-car', 'your-method[]', 'your-pay[]'],
    methodValues: PURCHASE_METHODS,
    payValues: PURCHASE_TIMING,
    refField: 'dl_ref',
    fileFields: [],
    messages: CONSULTING_MESSAGES,
    statusMessages: {
      mail_sent: CONSULTING_SENT,
      mail_failed: CONSULTING_FAILED,
      validation_failed: '성함, 연락처, 차종, 구매방식, 구매시기를 모두 입력 부탁드립니다.',
      spam: CONSULTING_SPAM,
    },
  },
  {
    key: 'consulting-used-car',
    cf7Id: '583',
    containerPost: '592',
    unitTag: 'wpcf7-f583-p592-o1',
    subject: '신차 상담신청',
    phoneField: 'your-phone',
    phoneMinLength: 13,
    requiredFields: ['your-name', 'your-phone', 'your-car', 'your-method[]', 'your-pay[]'],
    methodValues: PURCHASE_METHODS,
    payValues: PURCHASE_TIMING,
    refField: 'dl_ref',
    fileFields: [],
    messages: CONSULTING_MESSAGES,
    statusMessages: {
      mail_sent: CONSULTING_SENT,
      mail_failed: CONSULTING_FAILED,
      validation_failed: '성함, 연락처, 차종, 구매방식, 구매시기를 모두 입력 부탁드립니다.',
      spam: CONSULTING_SPAM,
    },
  },
  {
    key: 'consulting-detailing',
    cf7Id: '631',
    containerPost: '626',
    unitTag: 'wpcf7-f631-p626-o1',
    subject: '차량시공 문의',
    phoneField: 'your-telephone',
    phoneMinLength: null,
    requiredFields: ['your-name', 'your-telephone', 'your-car', 'your-method[]', 'your-pay[]'],
    methodValues: ['신차패키지', '디테일링', '유리막/광택', 'PPF/랩핑', '가죽코팅', '기타'],
    payValues: ['예약가능즉시', '1주일 이내', '1개월 이내', '미정'],
    refField: 'it_ref',
    fileFields: [],
    messages: CONSULTING_MESSAGES,
    statusMessages: {
      mail_sent: CONSULTING_SENT,
      mail_failed: CONSULTING_FAILED,
      // 원본에서 validation_error가 mail_sent_ng와 같은 문구로 설정되어 있다. 그대로 따른다.
      validation_failed: CONSULTING_FAILED,
      spam: CONSULTING_SPAM,
    },
  },
];

/**
 * 폼 583이 신차·중고차 두 페이지에 공유되므로 _wpcf7 하나로는 판정할 수 없다.
 * (_wpcf7, _wpcf7_container_post) 쌍으로 찾는다.
 */
export function findForm(cf7Id: string, containerPost: string): FormDefinition | null {
  return FORMS.find((f) => f.cf7Id === cf7Id && f.containerPost === containerPost) ?? null;
}
