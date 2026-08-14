# 컨택폼 백엔드 배포 절차

대상: dlas.co.kr Astro 미러(`dl_renovate`)의 컨택폼 백엔드
(Cloudflare Pages Functions + Supabase + Cloudflare R2)

이 문서에 나오는 URL·계정 ID·키 값은 전부 자리표시자(placeholder)다.
실제 값으로 바꿔 쓰되, 이 문서에는 실제 값을 적어 넣지 않는다.

## 0. 사전 준비물

- R2가 활성화된 Cloudflare 계정 (Workers/Pages 사용 권한 포함)
- Supabase 프로젝트 (URL, service role key를 발급받을 수 있어야 함)
- Resend 계정과, 발신 도메인 인증(DNS)이 완료된 상태
- 로컬 개발 환경: `npm`, `npx wrangler`가 동작하는 Node.js

## 1. 마이그레이션을 적용한다

`supabase/migrations/0001_contact_submissions.sql`을 Supabase 대시보드 →
SQL Editor에 붙여 실행한다.

**적용 여부를 먼저 확인할 것.** 이 프로젝트에서는 `contact_submissions`
테이블이 개발 중 SQL Editor에서 수동으로 이미 만들어졌을 수 있다.
아래 순서로 확인한다.

1. Supabase 대시보드 → Table Editor에서 `public.contact_submissions`가
   이미 보이는지 확인한다. 보이면 이미 적용된 것이다 — 다시 실행하지 않는다.
2. 확실하지 않으면 SQL Editor에서 마이그레이션 파일 내용을 그대로
   실행해본다. 이 파일은 일부러 `if not exists`를 쓰지 않았으므로,
   이미 테이블이 있다면 `relation "contact_submissions" already exists`
   에러가 나고 그것이 "이미 적용됨"의 증거가 된다. 아직 없다면
   에러 없이 테이블·인덱스·RLS 설정까지 한 번에 생성된다.
3. 실행 후에는 Table Editor에서 컬럼 목록이 마이그레이션 파일과
   일치하는지 육안으로 대조한다.

## 2. R2 버킷을 확인한다

`dlas-form-uploads`, `dlas-form-uploads-preview` 버킷은 이미 Cloudflare
계정에 생성되어 있다 (새로 만들 필요 없음). 아래를 **확인만** 한다.

```bash
npx wrangler r2 bucket list
```

두 버킷이 목록에 있는지 확인한 뒤, Cloudflare 대시보드 → R2 →
`dlas-form-uploads` → Settings에서:

- **Public access가 꺼져 있는지 확인한다.** 이 버킷에는 고객의 개인
  금융 서류(견적서 등)가 들어간다. Public access를 켜면 URL만 아는
  누구나 그 서류를 열람할 수 있게 되므로, 이 설정은 항상 꺼진 채로
  유지해야 한다. `dlas-form-uploads-preview`도 동일하게 확인한다.
- Object lifecycle rules에 3년 삭제 규칙이 있는지 확인한다 (없다면
  §7 "R2 라이프사이클 규칙" 절대로 만든다).

## 3. 시크릿을 등록한다

`src/lib/forms/env.ts`가 요구하는 환경변수 전체는 다음과 같다.
각각 `wrangler secret put`으로 등록한다.

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_ENABLED
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put NOTIFY_TO
npx wrangler secret put NOTIFY_FROM
npx wrangler secret put FILE_TOKEN_SECRET
npx wrangler secret put PUBLIC_SITE_ORIGIN

# 차선생 CRM 연동. 이것만 선택이다 — 없으면 연동이 꺼진 채로 사이트가 정상 동작한다.
npx wrangler secret put CRM_HOMEPAGE_SECRET
```

| 변수 | 용도 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. RLS를 우회해 서버에서 직접 쓰기 위함 |
| `TURNSTILE_ENABLED` | Turnstile 봇 방어 스위치. **런칭 시 반드시 `false`로 설정** (아래 §4 참고) |
| `TURNSTILE_SECRET` | Turnstile 검증용 시크릿 키. `TURNSTILE_ENABLED=false`일 때는 값이 없어도 되지만, 코드가 이 값을 요구하지 않도록 되어 있는지는 `TURNSTILE_ENABLED`가 먼저 결정한다 |
| `RESEND_API_KEY` | Resend API 키 (알림 메일 발송) |
| `NOTIFY_TO` | 담당자 알림 수신 주소. 쉼표로 여러 개 지정 가능 |
| `NOTIFY_FROM` | 발신 주소. Resend에서 **도메인 인증을 마친 주소**여야 한다. 인증 전에는 Resend가 발송을 거부한다 |
| `FILE_TOKEN_SECRET` | 첨부파일 서명 다운로드 링크 서명용 시크릿 (아래 생성법 참고) |
| `PUBLIC_SITE_ORIGIN` | 사이트의 정식 오리진(예: `https://dlas.co.kr`). 서명 링크 등에 쓰인다 |
| `CRM_HOMEPAGE_SECRET` | **선택.** 차선생 CRM 연동 시크릿. **이 값의 유무가 연동의 켜짐/꺼짐 스위치다** — 없으면 전송을 시도조차 하지 않아 재시도 예산도 소모되지 않는다. 계약은 `docs/crm-lead-integration.md` |
| `CRM_ENDPOINT` | **선택.** 스테이징 CRM으로 돌릴 때만 쓴다. 없으면 계약서의 운영 URL을 쓴다 |

`FILE_TOKEN_SECRET`은 다음으로 생성한다.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Turnstile은 런칭 시 사용하지 않는다

클라이언트 결정으로, 런칭 시점에는 어떤 폼에도 Turnstile 위젯을 넣지
않는다. **이것이 왜 위험한지 반드시 이해하고 넘어갈 것.**

`src/lib/forms/env.ts`의 `readTurnstileEnabled`는 `TURNSTILE_ENABLED`가
설정되어 있지 않으면 **기본값을 `true`(활성화)로 둔다.** 이는 배포 시
변수를 깜빡 빠뜨려도 봇 방어가 조용히 꺼지지 않도록 하기 위한
fail-secure 설계다. 그런데 지금은 폼에 위젯 자체가 없으므로,
`TURNSTILE_ENABLED`를 명시적으로 `false`로 설정하지 않으면 서버는
Turnstile 응답 토큰을 검증하려 하고, 위젯이 없으니 토큰이 never
전송되어 **모든 정상 제출이 스팸으로 거부된다.**

따라서 배포 환경에는 반드시 다음을 등록한다.

```bash
npx wrangler secret put TURNSTILE_ENABLED
# 값 입력: false
```

### 나중에 Turnstile을 켜는 방법

1. Cloudflare 대시보드 → Turnstile에서 site key / secret key를 발급받는다.
2. 각 폼(`analysis`, `consulting-new-car`, `consulting-used-car`,
   `consulting-detailing`)의 `<form>` 태그 안에 Turnstile 위젯
   (`cf-turnstile` div + site key)을 삽입한다.
3. `TURNSTILE_SECRET`을 실제 secret key 값으로 등록한다.
4. `TURNSTILE_ENABLED` 시크릿을 제거하거나 `true`로 바꾼다
   (미설정 시 기본값이 이미 `true`이므로 제거만 해도 된다).
5. 로컬에서 §6 통합 테스트를 다시 돌려, 위젯 없이 보낸 요청이
   `validation_failed`로 거부되는지 확인한다.

## 5. wrangler.jsonc의 compatibility_date를 함부로 올리지 않는다

`wrangler.jsonc`의 `compatibility_date`는 `2026-08-11`로 고정되어
있다. 이는 임의의 값이 아니라 **현재 설치된 workerd 바이너리가
지원하는 가장 최신 날짜**다. 이보다 미래 날짜로 바꾸면 워커가
시작조차 되지 않는다. wrangler나 workerd를 업그레이드하지 않은 채
"최신으로 맞춰두자"는 이유만으로 이 값을 올리지 말 것. 올릴 필요가
있다면 먼저 `npx wrangler --version`과 workerd 버전을 확인하고,
올린 뒤 로컬 `wrangler dev`가 정상 기동하는지 검증한다.

## 6. 로컬에서 통합 테스트한다

`.dev.vars.example`을 복사해 `.dev.vars`를 만든다. 이 파일에는 실제
키가 들어가므로 절대 커밋하지 않는다. `TURNSTILE_ENABLED=false`로
둔다(주석 해제).

```bash
cp .dev.vars.example .dev.vars
npm run build
npx wrangler dev
```

기본적으로 `wrangler dev`는 `http://localhost:8787`에서 뜬다.

**중요:** Astro의 CSRF 보호(`security.checkOrigin`)가 켜져 있어서,
`Origin` 헤더가 없거나 개발 서버와 다른 요청은 전부 HTTP 403으로
거부된다. 아래 모든 `curl` 명령에는 `-H "Origin: http://localhost:8787"`가
반드시 포함되어야 한다 (헤더를 빼면 403이 나는 것을 실제로 확인했다).

다른 터미널에서 제출을 흉내 낸다.

### 성공 케이스

```bash
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/583/feedback' \
  -H 'Origin: http://localhost:8787' \
  -H 'Referer: http://localhost:8787/consulting-new-car/' \
  -F '_wpcf7=583' \
  -F '_wpcf7_container_post=580' \
  -F '_wpcf7_unit_tag=wpcf7-f583-p580-o1' \
  -F 'your-name=테스트' \
  -F 'your-phone=010-1234-5678' \
  -F 'your-car=BMW 520i' \
  -F 'your-method[]=리스' \
  -F 'your-pay[]=좋은 조건 즉시' \
  -F 'your-message=통합 테스트'
```

Expected: `{"into":"#wpcf7-f583-p580-o1","status":"mail_sent",...}`

확인 항목:
- Supabase Table Editor에 레코드 1건이 생겼는가
- `form_subject`가 `신차 상담신청`인가
- `methods`가 `{리스}`인가
- `NOTIFY_TO` 주소로 메일이 왔는가

### 필수 필드 누락(validation_failed) 케이스

```bash
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/583/feedback' \
  -H 'Origin: http://localhost:8787' \
  -F '_wpcf7=583' -F '_wpcf7_container_post=580' \
  -F 'your-name=' -F 'your-phone=' -F 'your-car='
```

Expected: `"status":"validation_failed"` 이고 `invalid_fields`에 다섯 개
(`your-name`, `your-phone`, `your-car`, `your-method`, `your-pay`)가
들어 있다. 체크박스 두 개는 `[]` 없이 나와야 한다. 메시지는 모두
`정확하게 입력 부탁드립니다.`

### 첨부 있는 제출(analysis, 584) 케이스

```bash
printf '%%PDF-1.7\n' > /tmp/test.pdf
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/584/feedback' \
  -H 'Origin: http://localhost:8787' \
  -F '_wpcf7=584' -F '_wpcf7_container_post=609' \
  -F 'your-name=테스트' -F 'your-phone=010-1234-5678' \
  -F 'file-71=@/tmp/test.pdf'
```

Expected: `mail_sent`. 메일에 온 서명 링크를 브라우저로 열어 PDF가
내려받아지는지 확인한다.

### 위장 파일 거부 케이스

파일 확장자와 실제 내용이 다른 경우 거부되는지 확인한다.
`.pdf` 확장자에 진짜 PDF 시그니처(`%PDF-1.7`)를 쓰는 대신, `.png`
확장자에 PDF도 PNG도 아닌 바이너리(실행 파일 시그니처 `MZ`)를 넣어
콘텐츠 검증이 확장자만 보고 속지 않는지 확인한다.

```bash
printf 'MZ\x90\x00' > /tmp/fake.png
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/584/feedback' \
  -H 'Origin: http://localhost:8787' \
  -F '_wpcf7=584' -F '_wpcf7_container_post=609' \
  -F 'your-name=테스트' -F 'your-phone=010-1234-5678' \
  -F 'file-71=@/tmp/fake.png'
```

Expected: `"status":"validation_failed"` 이고 메시지가
`이 유형의 파일을 업로드하도록 허용하지 않습니다.`

## 7. R2 라이프사이클 규칙을 만든다

`wrangler`로는 만들 수 없다. Cloudflare 대시보드에서 수동으로 설정한다.

1. Cloudflare 대시보드 → R2 → `dlas-form-uploads` → Settings →
   Object lifecycle rules → **Add rule**.
2. 이름: 임의(예: `expire-submissions`).
3. Prefix: `submissions/`.
4. Action: Delete objects.
5. 조건: 업로드 후 **1095일**(3년) 경과.
6. 저장한다. `dlas-form-uploads-preview`에는 로컬/프리뷰용이므로
   동일 규칙을 반드시 만들 필요는 없지만, 만들어 두면 관리가 쉽다.

## 8. Cloudflare WAF rate limiting 규칙을 만든다

Cloudflare 대시보드 → Security → WAF → Rate limiting rules →
**Create rule**:

- 이름: `contact-form-submit`
- 매칭: `URI Path` starts with `/wp-json/contact-form-7/`
- 카운팅 기준: IP
- 임계값: 10분에 5회
- 동작: Block, 10분

## 9. 정적 자산 크기 주의사항

Cloudflare Pages/Workers 자산 업로드에는 자산당 25 MiB 제한이 있다.
`about` 페이지의 영상이 원래 87.5 MB였던 것을 18.5 MB로 재인코딩해서
이 제한을 넘겼던 이력이 있다 (디버깅에 실제로 시간이 들었다). 새
이미지·영상 등 정적 자산을 추가할 때는 반드시 25 MiB 미만인지 먼저
확인할 것. 초과 시 빌드/배포가 실패한다.

## 10. 운영 메모

- 담당자는 Supabase Table Editor의 `contact_submissions`에서 제출을 본다.
  `created_at desc` 정렬이 기본이다.
- 첨부파일 링크는 발송 7일 후 만료된다. 만료 후에는 R2 대시보드에서
  `attachments[].r2_key` 경로를 직접 찾아 내려받거나, 필요하면
  서명 링크를 재발급하는 절차(현재는 셀프서비스 재발급 기능이 없으므로
  개발자에게 요청)를 거친다.
- `email_error`가 채워진 레코드는 알림 메일이 실패한 건이다. 주기적으로
  확인한다.
- R2 객체는 3년 후 자동 삭제된다(§7 라이프사이클 규칙). Supabase의
  텍스트 레코드는 남는다.
- `crm_synced_at`이 채워져 있으면 차선생 CRM 등록까지 끝난 건이다(§10.5).
  null인데 `crm_error`가 차 있으면 재시도 중이거나 포기한 건이고, 포기한
  건은 담당자에게 알림 메일이 이미 나갔다. `CRM_HOMEPAGE_SECRET`을 등록하지
  않았다면 두 컬럼 모두 계속 null이다(연동이 꺼진 상태).
- 기존 dl.dbmg.kr(Zmes) 전송은 이 구현에 포함되지 않았다.
  원본 WordPress가 살아 있는 동안에는 그쪽이 계속 받는다.

## 10.5. CRM 재시도 크론

`wrangler.jsonc`의 `triggers.crons`(10분 주기)가 `src/worker.ts`의 `scheduled`를
깨워, 아직 CRM에 못 보낸 리드를 다시 보낸다. 배포 후 확인할 것:

1. Cloudflare 대시보드 → Workers → `dlas` → Settings → Trigger Events에
   Cron `*/10 * * * *`이 등록됐는지 본다. 없으면 `dist/server/wrangler.json`에
   `triggers`가 실렸는지부터 확인한다(어댑터가 생성하는 파일이다).
2. 로컬에서 크론을 직접 때려볼 수 있다.

```bash
npx wrangler dev --test-scheduled
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

   집어 온 건이 있을 때만 `crm retry {"picked":…}` 한 줄을 로그로 남긴다.
   (10분마다 조용한 로그를 쌓지 않기 위해서다.)
3. `CRM_HOMEPAGE_SECRET`이 없으면 크론은 조회조차 하지 않고 즉시 끝난다.
   연동을 잠시 끄고 싶으면 이 시크릿을 지우면 된다 — 그동안 들어온 리드는
   시도 횟수가 늘지 않은 채 남아 있다가, 시크릿을 다시 넣으면 크론이 한 번에 따라잡는다.

## 10.6. CF7 엔드포인트는 두 개다 — feedback과 refill

미러는 CF7 6.0.6 클라이언트를 그대로 쓰므로 **원본이 제공하던 REST 경로를 모두**
갖고 있어야 한다. 하나라도 빠지면 화면이 조용히 멈춘다.

| 경로 | 구현 | 없으면 |
|---|---|---|
| `POST /wp-json/contact-form-7/v1/contact-forms/{id}/feedback` | `src/pages/wp-json/.../feedback.ts` | 제출 자체가 실패 |
| `GET  /wp-json/contact-form-7/v1/contact-forms/{id}/refill` | `public/wp-json/.../{id}/refill` (원본과 같은 `[]`) | **제출 성공 문구가 영영 안 뜬다** |
| `GET  /wp-json/contact-form-7/v1/contact-forms/{id}/feedback/schema` | `public/wp-json/.../schema` (스냅샷) | 클라이언트 유효성 검사가 죽는다 |

refill이 왜 성공 문구를 좌우하는가: CF7은 `mail_sent`를 받으면 `form.reset()`을 부르고,
그 리셋 핸들러가 refill을 GET 하면서 폼 상태를 `resetting`으로 바꾼다. 상태를 다시
`mail_sent`로 되돌리는 것은 **refill 응답이 돌아온 뒤**다. 404가 나면 폼은 `resetting`에
갇히고, CSS `.wpcf7 form.resetting .wpcf7-response-output { display:none }` 때문에
초록 알림이 화면에 나타나지 않는다(문구는 DOM에 들어 있는데 감춰진 상태).

응답 본문도 원본과 같은 형태여야 한다. `contact_form_id`·`invalid_fields[].idref`·
`error_id`는 6.0.6 클라이언트가 읽지 않지만 원본이 싣는 값이라 같이 싣고,
`invalid_fields`의 순서는 SWV 스키마 규칙 순서를 따른다(`errorFieldOrder`).
원본은 **텍스트 검증을 통과한 뒤에야** 첨부를 검사하므로(이름이 비면 file 에러가
같이 나오지 않는다) 엔드포인트도 같은 순서로 처리한다.

전화번호 판정(`isValidTel`)은 원본 서버의 `wpcf7_is_tel()`을 그대로 옮긴 것이다.
구분 문자를 뗀 뒤 6~15자, `+`나 `00`으로 시작하면 국제번호로 접는다. 손대지 말 것.

## 11. 사전 런칭 체크리스트

- [ ] 마이그레이션 적용 여부를 확인했다 (§1)
- [ ] `contact_submissions` 테이블 컬럼이 마이그레이션 파일과 일치한다
- [ ] R2 버킷 두 개(`dlas-form-uploads`, `dlas-form-uploads-preview`)의
      Public access가 꺼져 있음을 확인했다
- [ ] R2 라이프사이클 규칙(3년 삭제)이 설정되어 있다
- [ ] `src/lib/forms/env.ts`가 요구하는 시크릿 전부를 등록했다
- [ ] `TURNSTILE_ENABLED=false`를 명시적으로 등록했다 (§4)
- [ ] `NOTIFY_FROM`이 Resend에서 도메인 인증을 마친 주소다
- [ ] `FILE_TOKEN_SECRET`을 새로 생성해 등록했다 (기존 값 재사용 금지)
- [ ] `wrangler.jsonc`의 `compatibility_date`를 임의로 올리지 않았다
- [ ] 로컬 `wrangler dev` 통합 테스트 4종(성공/검증 실패/첨부/위장 파일)을
      모두 통과했다
- [ ] CRM 연동을 켤 것이면 `CRM_HOMEPAGE_SECRET`을 등록하고, Cron 트리거가
      대시보드에 등록됐는지 확인했다 (§10.5)
- [ ] WAF rate limiting 규칙(`contact-form-submit`)을 등록했다
- [ ] 정적 자산 중 25 MiB를 넘는 파일이 없다
- [ ] `npm test`, `npm run build`가 배포 직전 기준으로 통과한다
- [ ] `.dev.vars`가 커밋되지 않았다
