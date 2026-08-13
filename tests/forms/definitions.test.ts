import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FORMS, findForm } from '../../src/lib/forms/definitions';

describe('findForm', () => {
  it('583은 container_post로 신차와 중고차를 구분한다', () => {
    expect(findForm('583', '580')?.key).toBe('consulting-new-car');
    expect(findForm('583', '592')?.key).toBe('consulting-used-car');
  });

  it('584와 631을 판정한다', () => {
    expect(findForm('584', '609')?.key).toBe('analysis');
    expect(findForm('631', '626')?.key).toBe('consulting-detailing');
  });

  it('알 수 없는 조합은 null이다', () => {
    expect(findForm('583', '999')).toBeNull();
    expect(findForm('9999', '580')).toBeNull();
    expect(findForm('', '')).toBeNull();
  });
});

describe('FORMS', () => {
  it('4개 폼이 정의되어 있다', () => {
    expect(FORMS).toHaveLength(4);
  });

  it('detailing만 전화 필드가 your-telephone이고 ref가 it_ref다', () => {
    const d = findForm('631', '626')!;
    expect(d.phoneField).toBe('your-telephone');
    expect(d.refField).toBe('it_ref');
    const a = findForm('584', '609')!;
    expect(a.phoneField).toBe('your-phone');
    expect(a.refField).toBe('dl_ref');
  });

  it('detailing만 전화 최소 길이 제한이 없다', () => {
    expect(findForm('584', '609')!.phoneMinLength).toBe(13);
    expect(findForm('583', '580')!.phoneMinLength).toBe(13);
    expect(findForm('631', '626')!.phoneMinLength).toBeNull();
  });

  it('analysis만 파일 필드를 가진다', () => {
    expect(findForm('584', '609')!.fileFields).toEqual(['file-71', 'file-72']);
    expect(findForm('583', '580')!.fileFields).toEqual([]);
  });

  it('체크박스 값이 원문 그대로다', () => {
    expect(findForm('583', '580')!.methodValues).toEqual(['운용리스', '장기렌트', '할부', '일시불']);
    expect(findForm('631', '626')!.methodValues).toEqual([
      '신차패키지', '디테일링', '유리막/광택', 'PPF/랩핑', '가죽코팅', '기타',
    ]);
    expect(findForm('631', '626')!.payValues).toEqual([
      '예약가능즉시', '1주일 이내', '1개월 이내', '미정',
    ]);
  });

  it('체크박스 두 개도 필수다', () => {
    expect(findForm('583', '592')!.requiredFields).toEqual([
      'your-name', 'your-phone', 'your-car', 'your-method[]', 'your-pay[]',
    ]);
    expect(findForm('631', '626')!.requiredFields).toEqual([
      'your-name', 'your-telephone', 'your-car', 'your-method[]', 'your-pay[]',
    ]);
  });

  it('analysis는 첨부 1개가 필수다', () => {
    expect(findForm('584', '609')!.requiredFields).toEqual([
      'your-name', 'your-phone', 'file-71',
    ]);
  });

  it('에러 문구가 원본 SWV 스키마와 같다', () => {
    const schema = (id: string) =>
      JSON.parse(
        readFileSync(
          `public/wp-json/contact-form-7/v1/contact-forms/${id}/feedback/schema`,
          'utf8',
        ),
      ) as { rules: { rule: string; field: string; error?: string }[] };

    const errorOf = (id: string, rule: string, field: string) =>
      schema(id).rules.find((r) => r.rule === rule && r.field === field)?.error;

    const analysis = findForm('584', '609')!;
    expect(analysis.messages.required).toBe(errorOf('584', 'required', 'your-name'));
    expect(analysis.messages.fileRequired).toBe(errorOf('584', 'requiredfile', 'file-71'));
    expect(analysis.messages.fileType).toBe(errorOf('584', 'file', 'file-71'));
    expect(analysis.messages.fileTooBig).toBe(errorOf('584', 'maxfilesize', 'file-71'));
    expect(analysis.messages.tel).toBe(errorOf('584', 'tel', 'your-phone'));
    expect(analysis.messages.telShort).toBe(errorOf('584', 'minlength', 'your-phone'));

    const newCar = findForm('583', '580')!;
    expect(newCar.messages.required).toBe(errorOf('583', 'required', 'your-name'));
    expect(newCar.messages.tooLong).toBe(errorOf('583', 'maxlength', 'your-name'));
    expect(newCar.messages.notEnum).toBe(errorOf('583', 'enum', 'your-method'));

    const detailing = findForm('631', '626')!;
    expect(detailing.messages.required).toBe(errorOf('631', 'required', 'your-name'));
    expect(detailing.messages.tel).toBe(errorOf('631', 'tel', 'your-telephone'));
  });

  it('상태 문구가 폼마다 다르다', () => {
    expect(findForm('584', '609')!.statusMessages.mail_sent).toBe(
      '신청완료 되었습니다. 빠른 연락 드리도록 하겠습니다.',
    );
    expect(findForm('583', '580')!.statusMessages.mail_sent).toBe(
      '찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다.',
    );
    expect(findForm('583', '592')!.statusMessages.validation_failed).toBe(
      '성함, 연락처, 차종, 구매방식, 구매시기를 모두 입력 부탁드립니다.',
    );
    // 631은 원본에서 validation_error와 mail_sent_ng가 같은 문구로 설정되어 있다
    const d = findForm('631', '626')!;
    expect(d.statusMessages.validation_failed).toBe(d.statusMessages.mail_failed);
  });
});
