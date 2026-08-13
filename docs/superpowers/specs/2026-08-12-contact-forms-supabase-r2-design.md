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

정확한 페이로드는 §11 부록에 전부 적어두었다. 구현 시 그 표를 단일 기준으로 삼는다.

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

이 엔드포인트를 우리가 구현하면 프론트 코드는 한 줄도 고치지 않아도 된다. 필드별 인라인 에러, 스피너, 성공 메시지 스타일, `wpcf7mailsent` 이벤트가 전부 현재와 동일하게 동작한다. schema 파일은 **이미 `public/`에 스냅샷되어 있다** (§11.7).

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
| `your-car` | `car` (consulting 3종에서 필수) |
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

---

## 12. 구현 후 남은 후속 과제

구현·리뷰를 마치고 기록한 것들이다. 어느 것도 배포를 막지 않지만, 순서대로 처리하면 좋다.

### 12.1 엔드포인트 회귀 테스트 (우선순위 1)

두 엔드포인트에는 단위 테스트가 없다. 순수 모듈 8개는 114개 테스트로 덮여 있지만, **리드 손실을 막는 불변식은 전부 엔드포인트 안에만 있다.** 그중 하나는 실제로 한 번 깨졌다가 고쳐졌고(핸들러 밖으로 새던 예외), 그 수정은 지금 회귀 보호가 전혀 없다.

가장 값이 큰 테스트 하나: 의존성을 주입해 `readEnv` 또는 `insertSubmission`이 던지게 하고, 응답이 **HTTP 200 + `mail_failed`** 인지 확인하는 것. 현재 구조는 의존성 주입이 안 되므로 엔드포인트에서 조립 부분을 분리하거나 miniflare 하네스를 붙여야 한다.

### 12.2 Turnstile 활성화

발주처 결정으로 미사용 상태로 출시한다. 스팸 방지는 WAF 속도 제한뿐이다. 봇 제출이 쌓이기 시작하면 `docs/deploy-forms.md`의 활성화 절차를 따른다. 코드는 이미 준비돼 있어 사이트 키·시크릿 발급, 위젯 한 줄 삽입, `TURNSTILE_ENABLED` 제거면 된다.

### 12.3 `notify.ts`의 오류 본문 기록

`sendEmail`이 실패하면 Resend 응답 본문 전체를 에러 메시지에 담고, 그 문자열이 `email_error` 컬럼에 저장된다. 고객 개인정보는 아니지만 담당자 수신 주소가 남을 수 있다. `db.ts`의 `describeError`와 같은 방식(상태 코드 + 기계식 코드만)으로 정리한다.

### 12.4 첨부 링크 셀프서비스 재발급

서명 링크는 7일 후 만료되고 재발급 UI가 없다. 현재는 `docs/deploy-forms.md`의 수동 절차를 따라야 한다. 담당자가 자주 겪는다면 관리 화면과 함께 다루는 것이 낫다.

### 12.5 R2 고아 객체 정리

R2 저장이 성공한 뒤 Supabase 저장이 실패하면 주인 없는 객체가 남는다. 키에 제출 ID가 들어 있어(`submissions/{연}/{월}/{id}/{n}-{파일명}`) DB와 대조해 찾을 수 있다. 발생 빈도가 낮아 지금은 수동 처리 대상이며, 3년 라이프사이클 규칙이 결국 지운다.

### 12.6 `dist/client/` 경로 전제

Cloudflare 어댑터를 붙이면 정적 산출물이 `dist/`가 아니라 `dist/client/`로 나온다. 빌드 산출물 경로를 참조하는 스크립트를 새로 만들 때 유의한다.

---

## 11. 부록 — 폼별 정확한 페이로드

`src/raw/*-body.html` 미러 마크업에서 직접 추출한 값이다. 구현 시 이 부록이 단일 기준이다.

### 11.1 CF7가 항상 함께 보내는 필드

모든 폼이 아래 12개를 그대로 POST한다. 우리 엔드포인트는 `_wpcf7`(폼 ID 확인)과 `_wpcf7_unit_tag`(응답 `into` 값)만 사용하고, 나머지는 **읽되 저장하지 않는다.**

| 필드 | analysis | new-car | used-car | detailing |
|---|---|---|---|---|
| `_wpcf7` | `584` | `583` | `583` | `631` |
| `_wpcf7_unit_tag` | `wpcf7-f584-p609-o1` | `wpcf7-f583-p580-o1` | `wpcf7-f583-p592-o1` | `wpcf7-f631-p626-o1` |
| `_wpcf7_container_post` | `609` | `580` | `592` | `626` |
| `_wpcf7_version` | `6.0.6` | 동일 | 동일 | 동일 |
| `_wpcf7_locale` | `ko_KR` | 동일 | 동일 | 동일 |
| `_wpcf7_posted_data_hash` | `''` | 동일 | 동일 | 동일 |
| `_wpcf7cf_hidden_group_fields` / `_hidden_groups` / `_visible_groups` / `_repeaters` | `[]` | 동일 | 동일 | 동일 |
| `_wpcf7cf_steps` | `{}` | 동일 | 동일 | 동일 |
| `_wpcf7cf_options` | JSON 문자열 | JSON 문자열 | JSON 문자열 | JSON 문자열 |

`_wpcf7`와 `_wpcf7_unit_tag`가 폼을 구분하는 유일한 신뢰 가능한 값이다. **`_wpcf7`만으로는 부족하다** — `583`이 신차·중고차 두 페이지에 쓰이므로, `form_key` 판정은 `(_wpcf7, _wpcf7_container_post)` 쌍으로 한다:

| `_wpcf7` | `_wpcf7_container_post` | `form_key` |
|---|---|---|
| 584 | 609 | `analysis` |
| 583 | 580 | `consulting-new-car` |
| 583 | 592 | `consulting-used-car` |
| 631 | 626 | `consulting-detailing` |

알 수 없는 조합이 오면 저장하지 않고 `spam` 상태로 응답한다.

### 11.2 사용자 입력 필드

| form_key | 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|---|
| analysis | `your-name` | text | ✅ | maxlength 400 |
| analysis | `your-phone` | tel | ✅ | maxlength 400, **minlength 13** |
| analysis | `your-message` | textarea | — | maxlength 2000 |
| analysis | `file-71` | file | ✅ (아래 주의) | `.jpg,.jpeg,.png,.pdf` |
| analysis | `file-72` | file | — | `.jpg,.jpeg,.png,.pdf` |
| new-car / used-car | `your-name` | text | ✅ | maxlength 400 |
| new-car / used-car | `your-phone` | tel | ✅ | maxlength 400, **minlength 13** |
| new-car / used-car | `your-car` | text | ✅ | maxlength 400 |
| new-car / used-car | `your-method[]` | checkbox | ✅ | 아래 값 목록 |
| new-car / used-car | `your-pay[]` | checkbox | ✅ | 아래 값 목록 |
| new-car / used-car | `your-message` | textarea | — | maxlength 2000 |
| detailing | `your-name` | text | ✅ | maxlength 400 |
| detailing | **`your-telephone`** | tel | ✅ | maxlength 400, minlength 없음, 초기값 `010-` |
| detailing | `your-car` | text | ✅ | maxlength 400 |
| detailing | `your-method[]` | checkbox | ✅ | 아래 값 목록 |
| detailing | `your-pay[]` | checkbox | ✅ | 아래 값 목록 |
| detailing | `your-message` | textarea | — | maxlength 2000 |

**체크박스도 필수다**: `your-method[]`와 `your-pay[]`는 마크업만 보면 필수 표시가 없지만, §11.7의 SWV 스키마에 `required` 규칙이 걸려 있다. 필수로 검증한다.

**`file-71` 주의**: 라벨 문구는 "(선택, 최대 2개)"이지만 input에 `wpcf7-validates-as-required`가 붙어 있고, SWV 스키마에도 `requiredfile` 규칙이 있으며 그 에러 문구가 "성함, 연락처, **최소 1개의 견적서 파일첨부** 부탁드립니다."다. 즉 첨부는 의도적으로 필수이고 **라벨 문구가 잘못된 것**이다. 필수로 검증한다.

**`your-phone` minlength 13**: `010-1234-5678` 형태(하이픈 포함 13자)를 전제한다. 화면에서는 `cleave.min.js`가 `.your_phone` 클래스에 붙어 입력 중 자동으로 하이픈을 넣는다 (`analysis`, `new-car`, `used-car`만 해당). `detailing`의 `your-telephone`은 이 클래스가 없어 자동 서식이 없고 minlength도 없다 — 사용자가 아무 형태로나 넣을 수 있다. 서버에서는 **양쪽 다 숫자만 추출해 저장한다**: 10~11자리면 `010-1234-5678` 형태로 정규화하고, 그 외 길이면 입력 원문을 그대로 저장한다 (해외 번호 등을 잃지 않기 위함).

### 11.3 체크박스 값 (원문 그대로)

`your-method[]`
- new-car / used-car: `리스`, `장기렌트`, `할부`, `현금`
- detailing: `신차패키지`, `디테일링`, `유리막/광택`, `PPF/랩핑`, `가죽코팅`, `기타`

`your-pay[]`
- new-car / used-car: `좋은 조건 즉시`, `이번달 구매 예정`, `다음달 계획 중`, `3개월 이상 예정`
- detailing: `예약가능즉시`, `1주일 이내`, `1개월 이내`, `미정`

체크박스는 다중 선택이며 아무것도 안 고르면 필드 자체가 전송되지 않는다. 두 필드 모두 **필수**이므로 아무것도 오지 않으면 `validation_failed`다. 목록 밖의 값이 오면 무시하는 게 아니라 역시 `validation_failed`로 응답한다 — SWV 스키마에 `enum` 규칙으로 정의되어 있어, 정상 브라우저에서는 발생할 수 없는 입력이다.

값은 번역·매핑 없이 **원문 문자열 그대로** `methods` / `pay_period` 배열에 넣는다 — 기존 zmes 전송도 그랬고, 담당자가 읽는 값이 바뀌면 안 된다.

### 11.4 히든 마케팅 필드

| 필드 | 폼 | 미러의 초기값 |
|---|---|---|
| `your-subject` | 전부 | `견적서 비교분석` / `신차 상담신청`(new·used 공통) / `차량시공 문의` |
| `dl_ref` | analysis, new-car, used-car | `''` |
| `it_ref` | detailing | `''` |
| `referer-page` | 전부 | `''` |

`dl_ref` / `it_ref` / `referer-page`는 미러 자산 어디에서도 채워지지 않아 **항상 빈 문자열로 전송된다.** 원본 사이트에서는 외부 태그(GTM 등)가 채웠을 가능성이 있으나 미러에는 그 코드가 없다. 이번 작업은 오는 값을 그대로 받아 `ref` / `referer_page`에 저장하기만 한다. 유입 경로 추적이 실제로 필요하면 별도 과제로 스크립트를 붙인다.

`your-subject`는 클라이언트가 보내는 값이라 신뢰하지 않는다. 저장할 `form_subject`는 §11.1의 `form_key` 판정 결과로 서버에서 결정하고, 전송된 `your-subject`는 무시한다.

### 11.5 우리가 추가하는 필드

| 필드 | 출처 | 용도 |
|---|---|---|
| `cf-turnstile-response` | Turnstile 위젯 (폼 내부) | 스팸 검증. 저장하지 않음 |

`source_page`는 폼 필드가 아니라 요청의 `Referer` 헤더에서 서버가 채운다.

### 11.6 기존 zmes 페이로드와의 대응

자체 CRM으로 넘길 때 참고할 매핑. 이번 구현 범위는 아니다.

| zmes 키 | 우리 컬럼 |
|---|---|
| `csName` | `name` |
| `csTel` | `phone` |
| `apiKey` | 없음 (폼 구분은 `form_key`) |
| `etc.브랜드/차종/모델` | `car` |
| `etc.구매방식` | `methods` (zmes는 `, `로 join한 문자열) |
| `etc.구매시기` | `pay_period` (동일하게 join) |
| `etc.문의사항` | `message` |
| `etc.마케팅경로` | `ref` |
| `etc.이전페이지` | `referer_page` |
| `file1` / `file2` | `attachments[0]` / `attachments[1]` (공개 URL 대신 서명 링크) |

### 11.7 SWV 스키마 — 검증 규칙의 정본

`public/wp-json/contact-form-7/v1/contact-forms/{583,584,631}/feedback/schema` 에 **원본 사이트에서 스냅샷한 실제 스키마 파일이 이미 존재한다** (포팅 당시 `port_page.py`가 받아둠). 이것이 원본 검증 규칙과 에러 문구의 정본이며, 서버 검증은 여기에 맞춘다. 새로 만들지 말고 이 파일을 읽어서 쓴다.

에러 문구는 CF7 기본값이 아니라 사이트가 커스터마이즈한 값이다. 서버 응답이 다른 문구를 쓰면 클라이언트 검증을 우회했을 때만 다른 메시지가 뜨는 불일치가 생기므로, **아래 문구를 그대로 쓴다.**

| 폼 | 규칙 | 필드 | 값 | 에러 문구 |
|---|---|---|---|---|
| 584 | requiredfile | `file-71` | | 성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다. |
| 584 | file | `file-71`, `file-72` | `.jpg .jpeg .png .pdf` | 이 유형의 파일을 업로드하도록 허용하지 않습니다. |
| 584 | maxfilesize | `file-71`, `file-72` | 10485760 | 파일이 너무 큽니다. |
| 584 | required | `your-name`, `your-phone` | | 성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다. |
| 584 | tel | `your-phone` | | 전화번호를 정확하게 입력해주세요. |
| 584 | minlength | `your-phone` | 13 | 정확한 휴대폰 번호를 입력해주세요. |
| 584 | maxlength | `your-name`, `your-phone` | 400 | 내용이 너무 깁니다. |
| 584 | maxlength | `your-message` | 2000 | 내용이 너무 깁니다. |
| 583 | required | `your-method`, `your-pay`, `your-name`, `your-phone`, `your-car` | | 정확하게 입력 부탁드립니다. |
| 583 | tel | `your-phone` | | 정확한 휴대폰 번호를 입력해주세요. |
| 583 | minlength | `your-phone` | 13 | 정확한 휴대폰 번호를 입력해주세요. |
| 583 | maxlength | `your-name`, `your-phone`, `your-car` | 400 | 내용이 너무 깁니다. |
| 583 | maxlength | `your-message` | 2000 | 내용이 너무 깁니다. |
| 583 | enum | `your-method`, `your-pay` | §11.3 목록 | 이 입력란을 통해 정의되지 않은 값이 제출되었습니다. |
| 631 | required | `your-method`, `your-pay`, `your-name`, `your-telephone`, `your-car` | | 정확하게 입력 부탁드립니다. |
| 631 | tel | `your-telephone` | | 정확한 휴대폰 번호를 입력해주세요. |
| 631 | maxlength | `your-name`, `your-telephone`, `your-car` | 400 | 내용이 너무 깁니다. |
| 631 | maxlength | `your-message` | 2000 | 내용이 너무 깁니다. |
| 631 | enum | `your-method`, `your-pay` | §11.3 목록 | 이 입력란을 통해 정의되지 않은 값이 제출되었습니다. |

읽어낸 사실 네 가지:

1. **`your-method[]`·`your-pay[]`는 필수다.** 마크업에는 필수 표시가 없어 놓치기 쉽다.
2. **`file-71`은 확정적으로 필수다.** 에러 문구가 의도를 직접 말해준다. 라벨의 "(선택)"이 오류다.
3. **최대 파일 크기는 10485760바이트(10MB)** — 추정이 아니라 원본 설정값이다.
4. **`invalid_fields`의 `field` 값에는 `[]`가 붙지 않는다** (`your-method`, `your-pay`). 전송 시 필드명은 `your-method[]`지만 에러를 붙일 때는 `your-method`다. 마크업의 `data-name` 속성과 일치시켜야 빨간 툴팁이 올바른 위치에 뜬다.

`tel` 규칙은 CF7의 `wpcf7_is_tel()`과 같은 판정을 쓴다: 숫자·`+`·`(`·`)`·`/`·`.`·`-`·공백 외의 문자가 있으면 실패.

폼 2470(리스료 계산기)의 스키마 파일도 존재하지만 제출 처리 대상이 아니므로 손대지 않는다.

### 11.8 상태 문구 — 원본 WordPress DB 실측

`.wpcf7-response-output`에 뜨는 큰 메시지다. 스키마 파일에는 없고 미러 HTML에도 없다. 원본 서버의 `wp_postmeta` 에서 `meta_key='_messages'`를 조회해 얻었다 (CF7이 폼별로 저장하는 값).

| CF7 키 | 우리 status | 584 (견적서 비교분석) | 583 (신차·중고차) | 631 (차량시공) |
|---|---|---|---|---|
| `mail_sent_ok` | `mail_sent` | 신청완료 되었습니다. 빠른 연락 드리도록 하겠습니다. | 찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다. | 찾아주셔서 감사합니다. 빠른 연락 드리도록 하겠습니다. |
| `mail_sent_ng` | `mail_failed` | 발송 중 오류가 발생했습니다. 다시 시도해주세요. | 상담신청 발송 중 오류가 발생했습니다. 다시 시도해주세요. | 상담신청 발송 중 오류가 발생했습니다. 다시 시도해주세요. |
| `validation_error` | `validation_failed` | 성함, 연락처, 최소 1개의 견적서 파일첨부 부탁드립니다. | 성함, 연락처, 차종, 구매방식, 구매시기를 모두 입력 부탁드립니다. | 상담신청 발송 중 오류가 발생했습니다. 다시 시도해주세요. |
| `spam` | `spam` | 안내문를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도하기 바랍니다. | 메시지를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도해주세요. | 메시지를 보내는 도중 오류가 발생했습니다. 나중에 다시 시도해주세요. |

오타(`안내문를`, 631의 `validation_error`가 발송 실패 문구인 것)까지 **원문 그대로 옮긴다.** 우리가 고치면 원본과 화면이 달라지고, 무엇이 의도이고 무엇이 실수인지는 발주처가 판단할 일이다. 문구 정리는 후속 과제로 남긴다.

583의 `validation_error` 문구가 "성함, 연락처, 차종, **구매방식, 구매시기**를 모두 입력"이라는 점이 §11.2에서 체크박스를 필수로 판정한 것과 일치한다.

DB에는 `accept_terms` 문구("상담신청은 개인정보 동의를 체크하셔야 합니다.")도 남아 있다. 즉 **개인정보 동의 체크박스가 한때 설정되어 있었다가 폼에서 빠진 것**이다. §2의 관찰과 맞아떨어진다.
