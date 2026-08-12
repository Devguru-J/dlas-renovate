# 컨택폼 백엔드 설계 — Supabase + Cloudflare R2

작성일: 2026-08-12
대상: dlas.co.kr Astro 미러 (`dl_renovate`)

## 1. 배경

현재 Astro 미러는 `output: 'static'`이라 폼 제출을 받을 곳이 없다. 원본 WordPress는 다음 조합으로 동작하고 있었다 (원본 서버 실측 확인).

| 구성요소 | 플러그인 | 역할 |
|---|---|---|
| 폼 | `contact-form-7` 6.0.6 + `cf7-conditional-fields` | 마크업·클라이언트 검증·AJAX 제출 |
| DB 저장 | `contact-form-cfdb7` | WP DB 저장, 관리자 화면 조회 |
| DB 저장(중복) | `contact-form-7-to-database-extension` | 같은 데이터를 한 번 더 저장 |
| 첨부파일 | cfdb7 | `wp-content/uploads/cfdb7_uploads/` 에 **공개 경로**로 저장 |
| 이메일 | `easy-wp-smtp` | 담당자 메일 발송 |
| 외부 전송 | `cf7-zmes-api` | `https://dl.dbmg.kr/api/requestPMDB` 로 POST |

`cf7-zmes-api`의 페이로드 (폼 583, 584만 전송, 631은 미전송):

```php
'csName' => your-name, 'csTel' => your-phone, 'apiKey' => 폼별 키,
'etc' => ['브랜드/차종/모델','구매방식','구매시기','문의사항','마케팅경로','이전페이지'],
'file1' => 첨부1 공개 URL, 'file2' => 첨부2 공개 URL
```

기존 방식의 문제:
- 고객 견적서가 URL만 알면 누구나 열리는 공개 경로에 있고, 그 URL을 외부 업체로 넘긴다.
- 같은 데이터가 두 플러그인에 중복 저장된다.

향후 자체 CRM이 `dl.dbmg.kr`(Zmes)를 대체할 예정이며, 위 페이로드 형태가 이관 시 참고 기준이 된다.

## 2. 대상 폼

| form_key | CF7 ID | 페이지 | `your-subject` | 첨부 |
|---|---|---|---|---|
| `analysis` | 584 | `/analysis` | 견적서 비교분석 | `file-71`, `file-72` |
| `consulting-new-car` | 583 | `/consulting-new-car` | 신차 상담신청 | 없음 |
| `consulting-used-car` | 583 | `/consulting-used-car` | 신차 상담신청 | 없음 |
| `consulting-detailing` | 631 | `/consulting-detailing` | 차량시공 문의 | 없음 |

`/lease-rate-calculator`(CF7 2470)는 제출 없는 계산기이므로 범위에서 제외한다.

필드 차이:
- `analysis`: `your-name`, `your-phone`, `your-message`, `file-71`, `file-72`
- `consulting-new-car` / `consulting-used-car`: `your-name`, `your-phone`, `your-car`, `your-method[]`(리스/장기렌트/할부/현금), `your-pay[]`(구매시기 4종), `your-message`
- `consulting-detailing`: `your-name`, **`your-telephone`**(주의: 이 폼만 이름이 다름), `your-car`, `your-method[]`(시공항목 6종), `your-pay[]`(예약시기 4종), `your-message`

공통 히든: `your-subject`, `dl_ref`(detailing은 `it_ref`), `referer-page`.

원본 폼 태그에 `wpcf7-acceptance-as-validation` 클래스가 붙어 있으나 **실제 동의 체크박스는 마크업에 없다.** 즉 개인정보 수집·이용 동의 UI 없이 개인정보를 수집하고 있다. 이번 설계는 원본 동작을 그대로 옮기므로 동의 필드를 검증하지 않는다. 다만 법적으로는 보완이 필요한 사안이므로 별도 과제로 분리해 기록해 둔다.

## 3. 결정 사항

| 항목 | 결정 |
|---|---|
| 런타임 | Cloudflare Pages Functions (사이트도 Cloudflare Pages 배포) |
| 텍스트 저장 | Supabase — **원본 저장소(source of truth)** |
| 파일 저장 | Cloudflare R2, 비공개 버킷 |
| 파일 접근 | 자체 서명 링크, 7일 만료 |
| 알림 | 이메일 + DB 저장 병행 (기존과 동일) |
| 조회 화면 | 별도 관리자 페이지 만들지 않음. Supabase Table Editor 사용 |
| CRM | 이번엔 연동하지 않음. 스키마에 자리만 확보 |
| 스팸 방지 | Cloudflare Turnstile + WAF rate limit |
| 업로드 경로 | 단일 multipart POST (브라우저 직접 업로드 아님) |
| 클라이언트 | 기존 CF7 JS 재사용, 프론트 코드 수정 없음 |

## 4. 아키텍처

```
브라우저 (기존 CF7 마크업·JS 그대로)
   │  multipart POST + Turnstile 토큰
   ▼
/wp-json/contact-form-7/v1/contact-forms/{id}/feedback   (Pages Function)
   ├─ Turnstile 검증 → 필드 검증 → 파일 검증
   ├─ R2 put (바인딩, 비공개 버킷)
   ├─ Supabase insert          ← 원본 저장소
   └─ 이메일 발송 (7일 서명 링크 포함)

/api/file/{submission_id}/{n}?t=<서명토큰>               (Pages Function)
   └─ 토큰 만료 검증 → R2 바인딩으로 스트리밍
```

Astro는 `output: 'static'`을 유지하고 Cloudflare 어댑터만 추가한다. 기존 32개 페이지는 그대로 정적으로 빌드되고, `prerender = false`를 명시한 API 라우트만 함수로 동작한다. 이 방식이 Astro 7에서 유효한지는 구현 착수 시점에 공식 문서로 확인한다 (Astro 5에서 `hybrid` 모드가 제거되고 이 형태로 통합됨).

R2 presigned URL 대신 자체 서명 링크(`/api/file/...`)를 쓰는 이유: R2 바인딩만으로 처리되어 S3 액세스키를 어디에도 저장할 필요가 없고, 만료 기간과 재발급을 직접 제어할 수 있다.

### 모듈 구성

| 파일 | 책임 | 의존 |
|---|---|---|
| `src/lib/forms/definitions.ts` | 폼 4종의 필드 정의·라벨·필수 여부 (단일 출처) | 없음 |
| `src/lib/forms/validate.ts` | 입력·파일 검증. 순수 함수 | definitions |
| `src/lib/forms/storage.ts` | R2 put, 서명 토큰 발급·검증 | R2 바인딩, `FILE_TOKEN_SECRET` |
| `src/lib/forms/db.ts` | Supabase insert | `SUPABASE_*` |
| `src/lib/forms/notify.ts` | 이메일 본문 생성·발송 | `RESEND_API_KEY`, `NOTIFY_TO` |
| `src/lib/forms/cf7.ts` | CF7 응답 JSON 생성 | definitions |
| `src/pages/wp-json/contact-form-7/v1/contact-forms/[id]/feedback.ts` | 위 조립 | 전부 |
| `src/pages/api/file/[id]/[n].ts` | 서명 링크 검증 + 파일 스트리밍 | storage |

각 모듈은 독립적으로 테스트 가능해야 한다. 특히 `validate.ts`와 `storage.ts`의 토큰 로직은 Cloudflare 런타임 없이 단위 테스트할 수 있어야 한다.

## 5. 클라이언트 연동

미러된 CF7 JS(`/wp-content/plugins/contact-form-7/includes/js/index.js`)는 인라인 설정 `wpcf7.api = {root:"/wp-json/", namespace:"contact-form-7/v1"}`을 읽어 다음과 같이 동작한다.

- 제출: `POST /wp-json/contact-form-7/v1/contact-forms/{id}/feedback` (multipart)
- 로드 시: `GET /wp-json/contact-form-7/v1/contact-forms/{id}/feedback/schema` (클라이언트 검증용)

이 엔드포인트를 우리가 구현하면 프론트 코드는 한 줄도 고치지 않아도 된다. 필드별 인라인 에러, 스피너, 성공 메시지 스타일, `wpcf7mailsent` 이벤트가 전부 현재와 동일하게 동작한다. schema는 폼별 정적 JSON을 `public/`에 두어 404를 없앤다.

응답 JSON 형식 (CF7 6.x 규약):

```json
{
  "into": "#wpcf7-f584-p609-o1",
  "status": "mail_sent",
  "message": "메시지가 성공적으로 발송되었습니다.",
  "posted_data_hash": "",
  "invalid_fields": []
}
```

`status`로 쓸 값: `mail_sent`(성공), `validation_failed`(입력 오류, `invalid_fields`에 `{field, message, idref:null, error_id}` 배열), `spam`(Turnstile 실패), `mail_failed`(서버 오류).

Turnstile 위젯은 각 폼의 submit 버튼 앞에 삽입한다. 폼 내부 요소이므로 CF7이 FormData를 만들 때 `cf-turnstile-response`가 자동으로 포함된다.

## 6. 데이터 흐름과 에러 처리

```
1. Turnstile 토큰 검증 (siteverify)        실패 → status: "spam"
2. 필드 검증 (이름·연락처 필수)             실패 → "validation_failed" + invalid_fields
3. 파일 검증                                실패 → "validation_failed"
4. submission_id(UUID v4) 생성 → R2 put
5. Supabase insert                          실패 → "mail_failed" (고객에게 재시도 안내)
6. 이메일 발송 (7일 서명 링크 포함)         실패 → 무시하고 계속
7. status: "mail_sent" 반환
```

원칙:

- **DB 저장이 성공 기준.** 이메일 발송이 실패해도 고객에게는 성공으로 응답하고 `email_error` 컬럼에 사유를 남긴다. 리드를 잃는 것보다 낫다.
- **R2 먼저, DB 나중.** 순서가 반대면 DB 레코드는 있는데 파일이 없는 상태가 생긴다. 이 순서면 최악의 경우 주인 없는 R2 객체만 남고, 키가 `submission_id` 기반이라 나중에 DB와 대조해 정리할 수 있다.

### 파일 검증 규칙

- 개수: 최대 2개
- 크기: 개당 최대 10MB
- 허용 형식: `.jpg`, `.jpeg`, `.png`, `.pdf` (원본 `accept` 속성과 동일)
- 확장자만 믿지 않고 **매직바이트**로 실제 형식을 확인한다 (JPEG `FF D8 FF`, PNG `89 50 4E 47`, PDF `25 50 44 46`)
- 파일명은 저장 시 정규화한다 (경로 구분자·제어문자 제거). 원본 파일명은 `attachments.filename`에 별도 보관해 이메일·조회 시 표시한다

### R2 키 규칙

```
submissions/{YYYY}/{MM}/{submission_id}/{n}-{정규화된_파일명}
```

`n`은 1 또는 2. 연·월 프리픽스는 라이프사이클 관리와 수동 탐색을 쉽게 하기 위함이다.

### 서명 토큰

`t` 파라미터는 `HMAC-SHA256(FILE_TOKEN_SECRET, "{submission_id}/{n}/{exp}")` + `exp`를 인코딩한 값이다. 검증은 만료 확인 → HMAC 재계산 비교 순으로 하고, 비교는 타이밍 안전 비교를 쓴다. 만료된 링크는 410을 반환한다. 재발급은 이번 범위에 없으며, 필요 시 Supabase에 저장된 `submission_id`로 스크립트를 돌려 새 링크를 만든다.

### Rate limit

코드가 아니라 Cloudflare WAF 규칙으로 건다: 해당 경로에 IP당 10분 5회. 배포 없이 조정 가능하다.

## 7. DB 스키마

테이블 하나. Supabase Table Editor에서 담당자가 직접 읽어야 하므로 주요 필드는 jsonb로 뭉치지 않고 컬럼으로 펼친다.

```sql
create table public.contact_submissions (
  id             uuid primary key,
  created_at     timestamptz not null default now(),
  form_key       text not null,
  form_subject   text not null,
  name           text not null,
  phone          text not null,
  car            text,
  methods        text[],
  pay_period     text[],
  message        text,
  ref            text,
  referer_page   text,
  source_page    text,
  attachments    jsonb not null default '[]'::jsonb,
  email_sent_at  timestamptz,
  email_error    text,
  crm_synced_at  timestamptz,
  crm_record_id  text,
  ip_hash        text,
  user_agent     text
);

create index on public.contact_submissions (created_at desc);
create index on public.contact_submissions (form_key, created_at desc);

alter table public.contact_submissions enable row level security;
-- 정책을 만들지 않는다. service role 키만 접근 가능해진다.
```

필드 매핑:

| 원본 CF7 필드 | 컬럼 |
|---|---|
| `your-name` | `name` |
| `your-phone` / `your-telephone` | `phone` (정규화: 숫자만 남기고 `010-1234-5678` 형태로) |
| `your-car` | `car` |
| `your-method[]` | `methods` |
| `your-pay[]` | `pay_period` |
| `your-message` | `message` |
| `dl_ref` / `it_ref` | `ref` |
| `referer-page` | `referer_page` |
| `your-subject` | `form_subject` |

`attachments` 항목 형태:

```json
[{"n":1,"filename":"견적서.pdf","size":482103,"content_type":"application/pdf",
  "r2_key":"submissions/2026/08/{id}/1-견적서.pdf"}]
```

`ip_hash`는 IP 원본이 아니라 `SHA256(ip + FILE_TOKEN_SECRET)`을 저장한다. 스팸 패턴 추적에는 충분하고 개인정보 보관은 피한다.

## 8. 설정

환경변수:

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용. anon 키는 사용하지 않는다 |
| `TURNSTILE_SECRET` | Turnstile siteverify |
| `RESEND_API_KEY` | 이메일 발송 |
| `NOTIFY_TO` | 담당자 수신 주소 (쉼표 구분 다중 가능) |
| `FILE_TOKEN_SECRET` | 서명 토큰 HMAC 키 + IP 해시 솔트 |

Turnstile **site key**는 공개값이므로 클라이언트에 하드코딩한다.

바인딩: R2 버킷 `FORM_UPLOADS` → 실제 버킷 `dlas-form-uploads` (비공개).

R2 라이프사이클: `submissions/` 프리픽스에 3년 후 자동 삭제 규칙. 개인정보 목적 달성 후 파기 원칙에 따른다. Supabase의 텍스트 레코드는 유지한다.

## 9. 테스트

**단위** (Cloudflare 런타임 없이 실행)
- 파일 검증: 확장자를 위장한 파일(`.png`인데 실제로는 실행파일), 10MB 초과, 첨부 3개, 빈 파일
- 전화번호 정규화: `01012345678`, `010-1234-5678`, `+82 10-1234-5678`
- 서명 토큰: 정상 발급·검증, 만료된 토큰 거부, 변조된 토큰 거부
- CF7 응답 생성: 각 status별 JSON 형태

**통합** (`wrangler dev` + 로컬 R2 + Supabase 테스트 프로젝트)
- 첨부 있는 제출 1건 → DB 레코드·R2 객체·응답 JSON 확인
- 첨부 없는 제출 1건
- Turnstile 실패 시 `spam` 응답
- 필수 필드 누락 시 `invalid_fields` 내용 확인

**수동 e2e**
- 4개 폼 각각 실제 브라우저에서 제출
- 이메일 수신 확인, 서명 링크로 파일 열기
- 만료 시각을 지난 토큰이 410을 반환하는지 확인
- 기존 페이지의 시각적 회귀가 없는지 확인 (Turnstile 위젯 삽입 위치)

## 10. 이번 범위에서 제외

- 관리자 조회 페이지 (Supabase Table Editor로 대체)
- CRM 실제 전송 (스키마에 `crm_synced_at`, `crm_record_id` 자리만 확보)
- 카카오 알림톡 / SMS
- `/lease-rate-calculator` (제출 없는 계산기)
- 만료된 파일 링크의 셀프서비스 재발급 UI
- 기존 WordPress에 쌓인 과거 제출 데이터의 이관
- 개인정보 수집·이용 동의 체크박스 신설 (§2 참고. 원본에 없는 요소라 별도 과제)
