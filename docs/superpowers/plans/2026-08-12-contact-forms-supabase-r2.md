# 컨택폼 백엔드 (Supabase + Cloudflare R2) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dlas.co.kr Astro 미러의 컨택폼 4종이 제출을 받아 텍스트는 Supabase에, 첨부파일은 비공개 Cloudflare R2에 저장하고 담당자에게 이메일로 알리게 한다.

**Architecture:** 미러에 그대로 살아있는 Contact Form 7 6.0.6 클라이언트 JS가 기대하는 엔드포인트(`/wp-json/contact-form-7/v1/contact-forms/{id}/feedback`)를 Astro의 on-demand 라우트로 직접 구현한다. 프론트엔드 코드는 수정하지 않는다. 검증·저장·알림 로직은 Cloudflare 런타임 의존이 없는 순수 모듈로 분리해 vitest로 단위 테스트하고, 엔드포인트는 그 모듈들을 조립만 한다.

**Tech Stack:** Astro 7.2 (`output: 'static'` 유지) / `@astrojs/cloudflare` 14 / Cloudflare Workers static assets / R2 바인딩 / Supabase PostgREST (fetch 직접 호출) / Resend REST API / Cloudflare Turnstile / vitest

**설계 문서:** `docs/superpowers/specs/2026-08-12-contact-forms-supabase-r2-design.md`
정확한 페이로드 값은 그 문서 §11 부록이 단일 기준이다.

## Global Constraints

- 기존 32개 페이지의 렌더링 결과는 **바이트 단위로 바뀌면 안 된다.** `output: 'static'`을 유지하고, 새로 만드는 API 라우트에만 `export const prerender = false`를 붙인다.
- `src/raw/*.html` 및 `src/pages/**/index.astro` 는 **수정하지 않는다.** 예외는 Task 12의 Turnstile 위젯 삽입 한 곳뿐이며, 그 변경도 폼 4종의 submit 버튼 앞으로 한정한다.
- 순수 로직 모듈(`src/lib/forms/*.ts`)은 `cloudflare:workers`를 import하지 않는다. import하는 순간 vitest에서 실행 불가능해진다. 바인딩·시크릿은 엔드포인트가 읽어서 인자로 넘긴다.
- 체크박스 값·`your-subject` 문자열은 **원문 그대로** 저장한다. 번역·정규화·매핑 금지.
- Supabase는 **service role 키로만** 접근한다. anon 키를 코드에 넣지 않는다. RLS는 켜되 정책을 만들지 않는다.
- 시크릿을 저장소에 커밋하지 않는다. 로컬은 `.dev.vars`(gitignore), 운영은 `wrangler secret`.
- 커밋 메시지는 한국어 conventional commit (`feat:`, `test:`, `chore:`, `docs:`).
- 모든 테스트 명령은 저장소 루트에서 실행한다.

## 폼 상수 (설계 문서 §11에서 확정된 값)

| form_key | `_wpcf7` | `_wpcf7_container_post` | `_wpcf7_unit_tag` | 제목 | 전화 필드 | ref 필드 |
|---|---|---|---|---|---|---|
| `analysis` | 584 | 609 | `wpcf7-f584-p609-o1` | 견적서 비교분석 | `your-phone` | `dl_ref` |
| `consulting-new-car` | 583 | 580 | `wpcf7-f583-p580-o1` | 신차 상담신청 | `your-phone` | `dl_ref` |
| `consulting-used-car` | 583 | 592 | `wpcf7-f583-p592-o1` | 신차 상담신청 | `your-phone` | `dl_ref` |
| `consulting-detailing` | 631 | 626 | `wpcf7-f631-p626-o1` | 차량시공 문의 | `your-telephone` | `it_ref` |

## File Structure

| 파일 | 책임 | Cloudflare 런타임 의존 |
|---|---|---|
| `src/lib/forms/definitions.ts` | 폼 4종 메타데이터, 폼 판정 | 없음 |
| `src/lib/forms/validate.ts` | 필수 필드·전화 정규화·체크박스 화이트리스트 | 없음 |
| `src/lib/forms/files.ts` | 매직바이트 판별·크기·파일명 정규화·R2 키 | 없음 |
| `src/lib/forms/token.ts` | 서명 토큰 발급·검증 (WebCrypto) | 없음 |
| `src/lib/forms/cf7.ts` | CF7 응답 JSON 생성 | 없음 |
| `src/lib/forms/db.ts` | Supabase insert (fetch) | 없음 |
| `src/lib/forms/notify.ts` | 이메일 본문 생성·발송 (fetch) | 없음 |
| `src/lib/forms/turnstile.ts` | Turnstile siteverify (fetch) | 없음 |
| `src/pages/wp-json/contact-form-7/v1/contact-forms/[id]/feedback.ts` | 제출 처리 조립 | 있음 |
| `src/pages/api/file/[id]/[n].ts` | 서명 링크 검증 + R2 스트리밍 | 있음 |
| `public/wp-json/.../{584,583,631}/feedback/schema` | swv 클라이언트 검증 스키마 | 없음 |
| `public/_headers` | schema 파일의 Content-Type 지정 | 없음 |
| `supabase/migrations/0001_contact_submissions.sql` | 테이블·인덱스·RLS | 없음 |
| `wrangler.jsonc` | 바인딩·assets 설정 | — |
| `docs/deploy-forms.md` | 배포·시크릿·R2·WAF 설정 절차 | — |

---

### Task 1: 프로젝트 기반 셋업 (Cloudflare 어댑터 + vitest)

**Files:**
- Modify: `package.json`
- Modify: `astro.config.mjs`
- Create: `wrangler.jsonc`
- Create: `vitest.config.ts`
- Create: `.dev.vars.example`
- Modify: `.gitignore`
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `npm test`(vitest), `npm run build`(Astro static + Cloudflare 어댑터), `wrangler.jsonc`의 R2 바인딩명 `FORM_UPLOADS`

- [ ] **Step 1: 현재 빌드 산출물의 기준선을 기록한다**

```bash
npm run build
find dist -name "*.html" | sort > /tmp/dist-baseline.txt
grep -c "" /tmp/dist-baseline.txt
```

기대: HTML 파일 32개. 이 목록을 Step 8에서 다시 비교한다.

- [ ] **Step 2: 의존성을 설치한다**

```bash
npm install @astrojs/cloudflare@^14.2.1
npm install -D vitest@^3 wrangler@^4
```

- [ ] **Step 3: vitest 설정을 만든다**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

`package.json`의 `scripts`에 추가:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: 셋업이 동작하는지 확인하는 테스트를 쓴다**

`tests/setup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('test setup', () => {
  it('WebCrypto HMAC를 쓸 수 있다', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('msg'));
    expect(new Uint8Array(sig).length).toBe(32);
  });
});
```

- [ ] **Step 5: 테스트를 실행해 통과를 확인한다**

Run: `npm test`
Expected: 1 passed. (WebCrypto는 Node 20+ 전역이므로 바로 통과해야 한다. 실패하면 Node 버전을 확인한다.)

- [ ] **Step 6: Astro에 Cloudflare 어댑터를 붙인다**

`astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  devToolbar: { enabled: false },
  site: 'https://dlas.co.kr',
});
```

`output: 'static'`을 그대로 둔다. 어댑터가 붙어 있어도 `prerender = false`를 명시한 라우트만 on-demand로 동작한다. `platformProxy`는 `astro dev`에서 R2 바인딩을 로컬 에뮬레이션으로 쓰기 위한 설정이다.

- [ ] **Step 7: wrangler 설정을 만든다**

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dlas",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2026-08-12",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "none"
  },
  "r2_buckets": [
    {
      "binding": "FORM_UPLOADS",
      "bucket_name": "dlas-form-uploads",
      "preview_bucket_name": "dlas-form-uploads-preview"
    }
  ]
}
```

- [ ] **Step 8: 정적 페이지가 그대로인지 확인한다**

```bash
npm run build
find dist -name "*.html" | sort > /tmp/dist-after.txt
diff /tmp/dist-baseline.txt /tmp/dist-after.txt && echo "SAME"
```

Expected: `SAME` 출력. 차이가 나오면 어댑터 설정이 정적 빌드를 바꾼 것이므로 계속 진행하지 말고 원인을 찾는다.

`not_found_handling`을 `"none"`으로 둔 이유: `"404-page"`로 두면 정적 자산에 없는 경로를 Cloudflare가 워커에 넘기지 않고 404 페이지로 바로 응답할 수 있다. 그러면 Task 10·11의 API 라우트가 영영 호출되지 않는다. 404 페이지 자체는 Astro가 프리렌더한 `dist/404.html`을 워커가 서빙한다. Task 13 Step 5에서 `wrangler dev`로 `curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/없는경로` 가 404를 내는지 함께 확인한다.

- [ ] **Step 9: 시크릿 템플릿과 gitignore를 정리한다**

`.dev.vars.example`:

```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
TURNSTILE_SECRET=
RESEND_API_KEY=
NOTIFY_TO=someone@dlas.co.kr
NOTIFY_FROM=noreply@dlas.co.kr
FILE_TOKEN_SECRET=
PUBLIC_SITE_ORIGIN=https://dlas.co.kr
```

`.gitignore`에 추가 (이미 있으면 건너뛴다):

```
.dev.vars
.wrangler/
```

- [ ] **Step 10: 커밋**

```bash
git add package.json package-lock.json astro.config.mjs wrangler.jsonc vitest.config.ts .dev.vars.example .gitignore tests/setup.test.ts
git commit -m "chore: Cloudflare 어댑터·wrangler·vitest 셋업"
```

---

### Task 2: 폼 정의 모듈

**Files:**
- Create: `src/lib/forms/definitions.ts`
- Test: `tests/forms/definitions.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type FormKey = 'analysis' | 'consulting-new-car' | 'consulting-used-car' | 'consulting-detailing'`
  - `interface FormDefinition { key, cf7Id, containerPost, unitTag, subject, phoneField, requiredFields, methodValues, payValues, refField, maxFiles, fileFields }`
  - `const FORMS: readonly FormDefinition[]`
  - `function findForm(cf7Id: string, containerPost: string): FormDefinition | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/definitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
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

  it('analysis만 파일 필드를 가진다', () => {
    expect(findForm('584', '609')!.fileFields).toEqual(['file-71', 'file-72']);
    expect(findForm('583', '580')!.fileFields).toEqual([]);
  });

  it('체크박스 값이 원문 그대로다', () => {
    expect(findForm('583', '580')!.methodValues).toEqual(['리스', '장기렌트', '할부', '현금']);
    expect(findForm('631', '626')!.methodValues).toEqual([
      '신차패키지', '디테일링', '유리막/광택', 'PPF/랩핑', '가죽코팅', '기타',
    ]);
    expect(findForm('631', '626')!.payValues).toEqual([
      '예약가능즉시', '1주일 이내', '1개월 이내', '미정',
    ]);
  });

  it('필수 필드가 폼별로 맞다', () => {
    expect(findForm('584', '609')!.requiredFields).toEqual(['your-name', 'your-phone', 'file-71']);
    expect(findForm('583', '592')!.requiredFields).toEqual(['your-name', 'your-phone', 'your-car']);
    expect(findForm('631', '626')!.requiredFields).toEqual(['your-name', 'your-telephone', 'your-car']);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/definitions.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/lib/forms/definitions"`

- [ ] **Step 3: 구현한다**

`src/lib/forms/definitions.ts`:

```ts
export type FormKey =
  | 'analysis'
  | 'consulting-new-car'
  | 'consulting-used-car'
  | 'consulting-detailing';

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
  /** 비어 있으면 validation_failed를 내는 필드들 */
  requiredFields: string[];
  /** your-method[]로 허용되는 값. 목록 밖의 값은 버린다 */
  methodValues: string[];
  /** your-pay[]로 허용되는 값. 목록 밖의 값은 버린다 */
  payValues: string[];
  /** 이 폼의 마케팅 유입 히든 필드 이름 */
  refField: 'dl_ref' | 'it_ref';
  /** 첨부 파일 필드. 없으면 빈 배열 */
  fileFields: string[];
}

const PURCHASE_METHODS = ['리스', '장기렌트', '할부', '현금'];
const PURCHASE_TIMING = ['좋은 조건 즉시', '이번달 구매 예정', '다음달 계획 중', '3개월 이상 예정'];

export const FORMS: readonly FormDefinition[] = [
  {
    key: 'analysis',
    cf7Id: '584',
    containerPost: '609',
    unitTag: 'wpcf7-f584-p609-o1',
    subject: '견적서 비교분석',
    phoneField: 'your-phone',
    // file-71은 라벨이 "(선택)"이지만 마크업상 wpcf7-validates-as-required다. 원본 동작을 따른다.
    requiredFields: ['your-name', 'your-phone', 'file-71'],
    methodValues: [],
    payValues: [],
    refField: 'dl_ref',
    fileFields: ['file-71', 'file-72'],
  },
  {
    key: 'consulting-new-car',
    cf7Id: '583',
    containerPost: '580',
    unitTag: 'wpcf7-f583-p580-o1',
    subject: '신차 상담신청',
    phoneField: 'your-phone',
    requiredFields: ['your-name', 'your-phone', 'your-car'],
    methodValues: PURCHASE_METHODS,
    payValues: PURCHASE_TIMING,
    refField: 'dl_ref',
    fileFields: [],
  },
  {
    key: 'consulting-used-car',
    cf7Id: '583',
    containerPost: '592',
    unitTag: 'wpcf7-f583-p592-o1',
    subject: '신차 상담신청',
    phoneField: 'your-phone',
    requiredFields: ['your-name', 'your-phone', 'your-car'],
    methodValues: PURCHASE_METHODS,
    payValues: PURCHASE_TIMING,
    refField: 'dl_ref',
    fileFields: [],
  },
  {
    key: 'consulting-detailing',
    cf7Id: '631',
    containerPost: '626',
    unitTag: 'wpcf7-f631-p626-o1',
    subject: '차량시공 문의',
    phoneField: 'your-telephone',
    requiredFields: ['your-name', 'your-telephone', 'your-car'],
    methodValues: ['신차패키지', '디테일링', '유리막/광택', 'PPF/랩핑', '가죽코팅', '기타'],
    payValues: ['예약가능즉시', '1주일 이내', '1개월 이내', '미정'],
    refField: 'it_ref',
    fileFields: [],
  },
];

/**
 * 폼 583이 신차·중고차 두 페이지에 공유되므로 _wpcf7 하나로는 판정할 수 없다.
 * (_wpcf7, _wpcf7_container_post) 쌍으로 찾는다.
 */
export function findForm(cf7Id: string, containerPost: string): FormDefinition | null {
  return (
    FORMS.find((f) => f.cf7Id === cf7Id && f.containerPost === containerPost) ?? null
  );
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/definitions.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/definitions.ts tests/forms/definitions.test.ts
git commit -m "feat: 컨택폼 4종 정의 모듈"
```

---

### Task 3: 입력 검증 모듈

**Files:**
- Create: `src/lib/forms/validate.ts`
- Test: `tests/forms/validate.test.ts`

**Interfaces:**
- Consumes: `FormDefinition` (Task 2)
- Produces:
  - `function normalizePhone(raw: string): string`
  - `function pickAllowed(values: string[], allowed: string[]): string[]`
  - `interface TextResult { name: string; phone: string; car: string | null; methods: string[]; payPeriod: string[]; message: string | null; ref: string | null; refererPage: string | null }`
  - `function validateText(def: FormDefinition, get: (name: string) => string | null, getAll: (name: string) => string[]): { ok: true; data: TextResult } | { ok: false; invalid: { field: string; message: string }[] }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizePhone, pickAllowed, validateText } from '../../src/lib/forms/validate';
import { findForm } from '../../src/lib/forms/definitions';

describe('normalizePhone', () => {
  it('휴대폰 11자리를 하이픈 형태로 만든다', () => {
    expect(normalizePhone('01012345678')).toBe('010-1234-5678');
    expect(normalizePhone('010-1234-5678')).toBe('010-1234-5678');
    expect(normalizePhone('010 1234 5678')).toBe('010-1234-5678');
  });

  it('10자리 구형 번호를 처리한다', () => {
    expect(normalizePhone('0111234567')).toBe('011-123-4567');
  });

  it('02 지역번호를 올바르게 끊는다', () => {
    expect(normalizePhone('0212345678')).toBe('02-1234-5678');
    expect(normalizePhone('021234567')).toBe('02-123-4567');
  });

  it('해석할 수 없으면 원문을 다듬어서 돌려준다', () => {
    expect(normalizePhone('  +82 10-1234-5678 ')).toBe('+82 10-1234-5678');
    expect(normalizePhone('전화주세요')).toBe('전화주세요');
  });
});

describe('pickAllowed', () => {
  it('허용 목록에 있는 값만 남긴다', () => {
    expect(pickAllowed(['리스', '해킹시도', '현금'], ['리스', '장기렌트', '할부', '현금']))
      .toEqual(['리스', '현금']);
  });

  it('허용 목록의 순서가 아니라 입력 순서를 유지한다', () => {
    expect(pickAllowed(['현금', '리스'], ['리스', '장기렌트', '할부', '현금']))
      .toEqual(['현금', '리스']);
  });

  it('중복을 제거한다', () => {
    expect(pickAllowed(['리스', '리스'], ['리스'])).toEqual(['리스']);
  });
});

function makeGetters(fields: Record<string, string | string[]>) {
  const get = (n: string) => {
    const v = fields[n];
    return typeof v === 'string' ? v : null;
  };
  const getAll = (n: string) => {
    const v = fields[n];
    return Array.isArray(v) ? v : [];
  };
  return { get, getAll };
}

describe('validateText', () => {
  const newCar = findForm('583', '580')!;
  const detailing = findForm('631', '626')!;

  it('정상 입력을 통과시킨다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '01012345678',
      'your-car': 'BMW 520i',
      'your-method[]': ['리스', '할부'],
      'your-pay[]': ['좋은 조건 즉시'],
      'your-message': '견적 부탁드립니다',
      'dl_ref': 'naver',
      'referer-page': '/lease/',
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      name: '홍길동',
      phone: '010-1234-5678',
      car: 'BMW 520i',
      methods: ['리스', '할부'],
      payPeriod: ['좋은 조건 즉시'],
      message: '견적 부탁드립니다',
      ref: 'naver',
      refererPage: '/lease/',
    });
  });

  it('필수 필드가 비면 invalid를 낸다', () => {
    const { get, getAll } = makeGetters({ 'your-name': '  ', 'your-phone': '', 'your-car': 'X' });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid.map((i) => i.field)).toEqual(['your-name', 'your-phone']);
    expect(r.invalid[0].message).toBe('입력란을 작성해 주세요.');
  });

  it('detailing은 your-telephone을 연락처로 읽는다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-telephone': '010-1111-2222',
      'your-car': '아반떼',
      'it_ref': 'kakao',
    });
    const r = validateText(detailing, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.phone).toBe('010-1111-2222');
    expect(r.data.ref).toBe('kakao');
  });

  it('허용 목록 밖 체크박스 값을 버린다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '01012345678',
      'your-car': 'X',
      'your-method[]': ['리스', '<script>'],
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.methods).toEqual(['리스']);
  });

  it('길이 초과를 잘라내지 않고 invalid로 처리한다', () => {
    const { get, getAll } = makeGetters({
      'your-name': 'ㄱ'.repeat(401),
      'your-phone': '01012345678',
      'your-car': 'X',
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid[0]).toEqual({ field: 'your-name', message: '입력이 너무 깁니다.' });
  });

  it('선택 필드가 없으면 null이다', () => {
    const { get, getAll } = makeGetters({
      'your-name': '홍길동',
      'your-phone': '01012345678',
      'your-car': 'X',
    });
    const r = validateText(newCar, get, getAll);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.message).toBeNull();
    expect(r.data.ref).toBeNull();
    expect(r.data.refererPage).toBeNull();
    expect(r.data.methods).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/validate.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/validate.ts`:

```ts
import type { FormDefinition } from './definitions';

/** CF7 ko_KR 기본 문구와 같은 텍스트를 쓴다 */
export const MSG_REQUIRED = '입력란을 작성해 주세요.';
export const MSG_TOO_LONG = '입력이 너무 깁니다.';

const MAX_TEXT = 400;
const MAX_MESSAGE = 2000;

/**
 * 숫자만 뽑아 한국 번호 형태로 맞춘다.
 * 해석할 수 없는 형태(해외 번호 등)는 잃지 않도록 원문을 그대로 돌려준다.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (digits.startsWith('02')) {
    if (digits.length === 10) return `02-${digits.slice(2, 6)}-${digits.slice(6)}`;
    if (digits.length === 9) return `02-${digits.slice(2, 5)}-${digits.slice(5)}`;
    return trimmed;
  }
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return trimmed;
}

/** 허용 목록에 있는 값만, 입력 순서대로, 중복 없이 남긴다 */
export function pickAllowed(values: string[], allowed: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!allowed.includes(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export interface TextResult {
  name: string;
  phone: string;
  car: string | null;
  methods: string[];
  payPeriod: string[];
  message: string | null;
  ref: string | null;
  refererPage: string | null;
}

export type TextValidation =
  | { ok: true; data: TextResult }
  | { ok: false; invalid: { field: string; message: string }[] };

function optional(raw: string | null, max: number): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  return t === '' ? null : t.slice(0, max);
}

/**
 * 파일을 제외한 모든 입력을 검증한다.
 * get은 단일 값, getAll은 다중 값(체크박스) 접근자다. FormData에 직접 의존하지 않아
 * Cloudflare 런타임 없이 테스트할 수 있다.
 */
export function validateText(
  def: FormDefinition,
  get: (name: string) => string | null,
  getAll: (name: string) => string[],
): TextValidation {
  const invalid: { field: string; message: string }[] = [];

  // 필수 필드 (파일 필드는 여기서 다루지 않는다)
  for (const field of def.requiredFields) {
    if (def.fileFields.includes(field)) continue;
    const v = (get(field) ?? '').trim();
    if (v === '') invalid.push({ field, message: MSG_REQUIRED });
  }

  // 길이 제한
  for (const [field, max] of [
    ['your-name', MAX_TEXT],
    [def.phoneField, MAX_TEXT],
    ['your-car', MAX_TEXT],
    ['your-message', MAX_MESSAGE],
  ] as const) {
    const v = get(field);
    if (v !== null && v.trim().length > max) {
      invalid.push({ field, message: MSG_TOO_LONG });
    }
  }

  if (invalid.length > 0) return { ok: false, invalid };

  return {
    ok: true,
    data: {
      name: (get('your-name') ?? '').trim(),
      phone: normalizePhone(get(def.phoneField) ?? ''),
      car: optional(get('your-car'), MAX_TEXT),
      methods: pickAllowed(getAll('your-method[]'), def.methodValues),
      payPeriod: pickAllowed(getAll('your-pay[]'), def.payValues),
      message: optional(get('your-message'), MAX_MESSAGE),
      ref: optional(get(def.refField), MAX_TEXT),
      refererPage: optional(get('referer-page'), MAX_TEXT),
    },
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/validate.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/validate.ts tests/forms/validate.test.ts
git commit -m "feat: 컨택폼 입력 검증·전화번호 정규화"
```

---

### Task 4: 파일 검증 모듈

**Files:**
- Create: `src/lib/forms/files.ts`
- Test: `tests/forms/files.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `const MAX_FILE_BYTES = 10485760`
  - `function detectFileType(head: Uint8Array): { ext: string; mime: string } | null`
  - `function sanitizeFilename(name: string): string`
  - `function r2Key(id: string, n: number, filename: string, at: Date): string`
  - `interface AttachmentMeta { n: number; filename: string; size: number; content_type: string; r2_key: string }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/files.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/files.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/files.ts`:

```ts
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
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/files.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/files.ts tests/forms/files.test.ts
git commit -m "feat: 첨부파일 매직바이트 검증·파일명 정규화·R2 키"
```

---

### Task 5: 서명 토큰 모듈

**Files:**
- Create: `src/lib/forms/token.ts`
- Test: `tests/forms/token.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `const FILE_TOKEN_TTL_MS = 604800000` (7일)
  - `function signFileToken(secret: string, id: string, n: number, exp: number): Promise<string>`
  - `function verifyFileToken(secret: string, id: string, n: number, token: string, now: number): Promise<'ok' | 'expired' | 'invalid'>`
  - `function hashIp(secret: string, ip: string): Promise<string>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FILE_TOKEN_TTL_MS, signFileToken, verifyFileToken, hashIp,
} from '../../src/lib/forms/token';

const SECRET = 'test-secret-do-not-use';
const ID = '11111111-2222-3333-4444-555555555555';
const NOW = 1_800_000_000_000;

describe('signFileToken / verifyFileToken', () => {
  it('TTL은 7일이다', () => {
    expect(FILE_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('정상 토큰을 통과시킨다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + FILE_TOKEN_TTL_MS);
    expect(await verifyFileToken(SECRET, ID, 1, t, NOW)).toBe('ok');
  });

  it('만료된 토큰은 expired다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW - 1);
    expect(await verifyFileToken(SECRET, ID, 1, t, NOW)).toBe('expired');
  });

  it('다른 제출 ID로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken(SECRET, 'other-id', 1, t, NOW)).toBe('invalid');
  });

  it('다른 순번으로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken(SECRET, ID, 2, t, NOW)).toBe('invalid');
  });

  it('다른 시크릿으로는 통과하지 못한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    expect(await verifyFileToken('another-secret', ID, 1, t, NOW)).toBe('invalid');
  });

  it('만료시각만 늘린 변조 토큰을 거부한다', async () => {
    const t = await signFileToken(SECRET, ID, 1, NOW + 1000);
    const sig = t.split('.')[1];
    const tampered = `${NOW + 999_999_999}.${sig}`;
    expect(await verifyFileToken(SECRET, ID, 1, tampered, NOW)).toBe('invalid');
  });

  it('형식이 깨진 토큰을 거부한다', async () => {
    for (const bad of ['', 'abc', '123', '.', 'abc.def', `${NOW + 1000}.`]) {
      expect(await verifyFileToken(SECRET, ID, 1, bad, NOW)).toBe('invalid');
    }
  });
});

describe('hashIp', () => {
  it('같은 입력은 같은 해시를 낸다', async () => {
    expect(await hashIp(SECRET, '1.2.3.4')).toBe(await hashIp(SECRET, '1.2.3.4'));
  });

  it('다른 IP는 다른 해시를 낸다', async () => {
    expect(await hashIp(SECRET, '1.2.3.4')).not.toBe(await hashIp(SECRET, '1.2.3.5'));
  });

  it('원본 IP가 결과에 남지 않는다', async () => {
    const h = await hashIp(SECRET, '1.2.3.4');
    expect(h).not.toContain('1.2.3.4');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/token.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/token.ts`:

```ts
export const FILE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 길이가 달라도 조기 반환하지 않는다 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function payload(id: string, n: number, exp: number): string {
  return `${id}/${n}/${exp}`;
}

/** 토큰 형식: `<만료시각ms>.<base64url HMAC>` */
export async function signFileToken(
  secret: string,
  id: string,
  n: number,
  exp: number,
): Promise<string> {
  const sig = await hmac(secret, payload(id, n, exp));
  return `${exp}.${toBase64Url(sig)}`;
}

export async function verifyFileToken(
  secret: string,
  id: string,
  n: number,
  token: string,
  now: number,
): Promise<'ok' | 'expired' | 'invalid'> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return 'invalid';

  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expRaw)) return 'invalid';

  const exp = Number(expRaw);
  const expected = toBase64Url(await hmac(secret, payload(id, n, exp)));
  if (!timingSafeEqual(sig, expected)) return 'invalid';

  // 서명 확인이 끝난 뒤에 만료를 본다. 변조 토큰이 expired로 새어 나가지 않게 한다.
  return exp < now ? 'expired' : 'ok';
}

/** 원본 IP를 저장하지 않기 위해 시크릿을 솔트로 써서 해시만 남긴다 */
export async function hashIp(secret: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:${ip}`));
  return toHex(new Uint8Array(digest));
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/token.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/token.ts tests/forms/token.test.ts
git commit -m "feat: 첨부파일 서명 토큰과 IP 해시"
```

---

### Task 6: CF7 응답 모듈

**Files:**
- Create: `src/lib/forms/cf7.ts`
- Test: `tests/forms/cf7.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type Cf7Status = 'mail_sent' | 'mail_failed' | 'validation_failed' | 'spam'`
  - `const CF7_MESSAGES: Record<Cf7Status, string>`
  - `function cf7Response(unitTag: string, status: Cf7Status, invalidFields?: { field: string; message: string }[]): Response`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/cf7.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cf7Response, CF7_MESSAGES } from '../../src/lib/forms/cf7';

describe('cf7Response', () => {
  it('성공 응답 형태가 CF7 규약과 맞는다', async () => {
    const res = cf7Response('wpcf7-f584-p609-o1', 'mail_sent');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      into: '#wpcf7-f584-p609-o1',
      status: 'mail_sent',
      message: CF7_MESSAGES.mail_sent,
      posted_data_hash: '',
      invalid_fields: [],
    });
  });

  it('검증 실패 시 invalid_fields를 담는다', async () => {
    const res = cf7Response('wpcf7-f583-p580-o1', 'validation_failed', [
      { field: 'your-name', message: '입력란을 작성해 주세요.' },
    ]);
    const body = await res.json();
    expect(body.status).toBe('validation_failed');
    expect(body.invalid_fields).toEqual([
      { field: 'your-name', message: '입력란을 작성해 주세요.' },
    ]);
  });

  it('CF7 JS가 fetch를 실패로 보지 않도록 항상 200을 낸다', () => {
    expect(cf7Response('t', 'spam').status).toBe(200);
    expect(cf7Response('t', 'mail_failed').status).toBe(200);
    expect(cf7Response('t', 'validation_failed').status).toBe(200);
  });

  it('네 가지 상태 문구가 모두 한국어로 정의되어 있다', () => {
    for (const s of ['mail_sent', 'mail_failed', 'validation_failed', 'spam'] as const) {
      expect(CF7_MESSAGES[s].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/cf7.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/cf7.ts`:

```ts
export type Cf7Status = 'mail_sent' | 'mail_failed' | 'validation_failed' | 'spam';

/** CF7 ko_KR 기본 문구 */
export const CF7_MESSAGES: Record<Cf7Status, string> = {
  mail_sent: '메시지가 발송되었습니다. 감사합니다.',
  mail_failed:
    '메시지 발송 시도 중 오류가 발생했습니다. 나중에 다시 시도해 주세요.',
  validation_failed:
    '하나 이상의 필드에 오류가 있습니다. 확인 후 다시 시도해 주세요.',
  spam: '메시지 발송 시도 중 오류가 발생했습니다. 나중에 다시 시도해 주세요.',
};

/**
 * CF7 6.0.6 클라이언트는 응답의 status와 invalid_fields만 본다.
 * HTTP 상태는 항상 200이어야 한다. 4xx/5xx면 클라이언트가 fetch 자체를 실패로 처리해
 * 사용자에게 아무 메시지도 보여주지 않는다.
 */
export function cf7Response(
  unitTag: string,
  status: Cf7Status,
  invalidFields: { field: string; message: string }[] = [],
): Response {
  return new Response(
    JSON.stringify({
      into: `#${unitTag}`,
      status,
      message: CF7_MESSAGES[status],
      posted_data_hash: '',
      invalid_fields: invalidFields,
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/cf7.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/cf7.ts tests/forms/cf7.test.ts
git commit -m "feat: CF7 응답 JSON 생성"
```

---

### Task 7: Supabase 저장 모듈

**Files:**
- Create: `src/lib/forms/db.ts`
- Test: `tests/forms/db.test.ts`

**Interfaces:**
- Consumes: `AttachmentMeta` (Task 4), `FormKey` (Task 2)
- Produces:
  - `interface SubmissionRow { id, form_key, form_subject, name, phone, car, methods, pay_period, message, ref, referer_page, source_page, attachments, email_sent_at, email_error, ip_hash, user_agent }`
  - `interface SupabaseConfig { url: string; serviceRoleKey: string }`
  - `function insertSubmission(cfg: SupabaseConfig, row: SubmissionRow, fetchImpl?: typeof fetch): Promise<void>`
  - `function updateEmailStatus(cfg: SupabaseConfig, id: string, patch: { email_sent_at: string | null; email_error: string | null }, fetchImpl?: typeof fetch): Promise<void>`

`@supabase/supabase-js`를 쓰지 않고 PostgREST를 fetch로 직접 부른다. insert 한 번뿐이라 의존성을 추가할 이유가 없고, fetch를 주입할 수 있어 테스트가 쉽다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { insertSubmission, updateEmailStatus, type SubmissionRow } from '../../src/lib/forms/db';

const CFG = { url: 'https://proj.supabase.co', serviceRoleKey: 'service-key' };

function row(): SubmissionRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    form_key: 'analysis',
    form_subject: '견적서 비교분석',
    name: '홍길동',
    phone: '010-1234-5678',
    car: null,
    methods: [],
    pay_period: [],
    message: null,
    ref: null,
    referer_page: null,
    source_page: 'https://dlas.co.kr/analysis/',
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: 'abc',
    user_agent: 'test-agent',
  };
}

describe('insertSubmission', () => {
  it('PostgREST 엔드포인트로 service role 키를 실어 POST한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response('', { status: 201 });
    };

    await insertSubmission(CFG, row(), fake);

    expect(seen!.url).toBe('https://proj.supabase.co/rest/v1/contact_submissions');
    expect(seen!.init.method).toBe('POST');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('service-key');
    expect(headers.Authorization).toBe('Bearer service-key');
    expect(headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(seen!.init.body as string).name).toBe('홍길동');
  });

  it('실패 응답이면 본문을 포함한 에러를 던진다', async () => {
    const fake: typeof fetch = async () =>
      new Response('duplicate key value', { status: 409 });

    await expect(insertSubmission(CFG, row(), fake)).rejects.toThrow(
      /409.*duplicate key value/,
    );
  });

  it('URL 끝의 슬래시를 중복시키지 않는다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response('', { status: 201 });
    };
    await insertSubmission({ ...CFG, url: 'https://proj.supabase.co/' }, row(), fake);
    expect(seen).toBe('https://proj.supabase.co/rest/v1/contact_submissions');
  });
});

describe('updateEmailStatus', () => {
  it('id로 좁혀 PATCH한다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response('', { status: 204 });
    };

    await updateEmailStatus(CFG, 'sub-1', { email_sent_at: '2026-08-12T00:00:00Z', email_error: null }, fake);

    expect(seen!.url).toBe('https://proj.supabase.co/rest/v1/contact_submissions?id=eq.sub-1');
    expect(seen!.init.method).toBe('PATCH');
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      email_sent_at: '2026-08-12T00:00:00Z',
      email_error: null,
    });
  });

  it('실패해도 던지지 않는다', async () => {
    const fake: typeof fetch = async () => new Response('nope', { status: 500 });
    await expect(
      updateEmailStatus(CFG, 'sub-1', { email_sent_at: null, email_error: 'x' }, fake),
    ).resolves.toBeUndefined();
  });
});
```

`updateEmailStatus`는 알림 상태를 기록만 하는 보조 경로다. 여기서 예외를 던지면 이미 저장에 성공한 제출을 실패로 응답하게 되므로, 실패를 삼키고 콘솔에만 남긴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/db.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/db.ts`:

```ts
import type { FormKey } from './definitions';
import type { AttachmentMeta } from './files';

export interface SubmissionRow {
  id: string;
  form_key: FormKey;
  form_subject: string;
  name: string;
  phone: string;
  car: string | null;
  methods: string[];
  pay_period: string[];
  message: string | null;
  ref: string | null;
  referer_page: string | null;
  source_page: string | null;
  attachments: AttachmentMeta[];
  email_sent_at: string | null;
  email_error: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export async function insertSubmission(
  cfg: SupabaseConfig,
  row: SubmissionRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/rest/v1/contact_submissions`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    throw new Error(`supabase insert failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * 알림 발송 결과를 기록한다. 보조 경로라 실패해도 던지지 않는다.
 * 여기서 던지면 이미 저장에 성공한 제출을 실패로 응답하게 된다.
 */
export async function updateEmailStatus(
  cfg: SupabaseConfig,
  id: string,
  patch: { email_sent_at: string | null; email_error: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(
      `${base}/rest/v1/contact_submissions?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      console.error('email status update failed', res.status, await res.text());
    }
  } catch (err) {
    console.error('email status update failed', err);
  }
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/db.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/db.ts tests/forms/db.test.ts
git commit -m "feat: Supabase 제출 저장"
```

---

### Task 8: 이메일 알림 모듈

**Files:**
- Create: `src/lib/forms/notify.ts`
- Test: `tests/forms/notify.test.ts`

**Interfaces:**
- Consumes: `SubmissionRow` (Task 7)
- Produces:
  - `function escapeHtml(s: string): string`
  - `function buildEmail(row: SubmissionRow, fileLinks: { filename: string; url: string }[]): { subject: string; html: string }`
  - `interface MailConfig { apiKey: string; from: string; to: string[] }`
  - `function sendEmail(cfg: MailConfig, subject: string, html: string, fetchImpl?: typeof fetch): Promise<void>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/notify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEmail, escapeHtml, sendEmail } from '../../src/lib/forms/notify';
import type { SubmissionRow } from '../../src/lib/forms/db';

function row(over: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: 'sub-1',
    form_key: 'consulting-new-car',
    form_subject: '신차 상담신청',
    name: '홍길동',
    phone: '010-1234-5678',
    car: 'BMW 520i',
    methods: ['리스', '할부'],
    pay_period: ['좋은 조건 즉시'],
    message: '견적 부탁드립니다',
    ref: 'naver',
    referer_page: '/lease/',
    source_page: 'https://dlas.co.kr/consulting-new-car/',
    attachments: [],
    email_sent_at: null,
    email_error: null,
    ip_hash: 'h',
    user_agent: 'ua',
    ...over,
  };
}

describe('escapeHtml', () => {
  it('HTML 특수문자를 이스케이프한다', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
});

describe('buildEmail', () => {
  it('제목에 폼 이름과 신청자를 넣는다', () => {
    const { subject } = buildEmail(row(), []);
    expect(subject).toBe('[신차 상담신청] 홍길동 010-1234-5678');
  });

  it('체크박스는 쉼표로 이어 붙인다', () => {
    const { html } = buildEmail(row(), []);
    expect(html).toContain('리스, 할부');
    expect(html).toContain('좋은 조건 즉시');
  });

  it('첨부 링크를 넣고 만료를 안내한다', () => {
    const { html } = buildEmail(row({ form_key: 'analysis', form_subject: '견적서 비교분석' }), [
      { filename: '견적서.pdf', url: 'https://dlas.co.kr/api/file/sub-1/1?t=abc' },
    ]);
    expect(html).toContain('https://dlas.co.kr/api/file/sub-1/1?t=abc');
    expect(html).toContain('견적서.pdf');
    expect(html).toContain('7일');
  });

  it('첨부가 없으면 첨부 항목을 넣지 않는다', () => {
    const { html } = buildEmail(row(), []);
    expect(html).not.toContain('첨부파일');
  });

  it('사용자 입력을 이스케이프한다', () => {
    const { html } = buildEmail(row({ name: '<img src=x onerror=alert(1)>' }), []);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('빈 필드는 표에서 생략한다', () => {
    const { html } = buildEmail(row({ car: null, message: null, methods: [], pay_period: [] }), []);
    expect(html).not.toContain('차종');
    expect(html).not.toContain('문의사항');
  });
});

describe('sendEmail', () => {
  it('Resend API로 보낸다', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response('{"id":"x"}', { status: 200 });
    };

    await sendEmail(
      { apiKey: 'key', from: 'noreply@dlas.co.kr', to: ['a@dlas.co.kr', 'b@dlas.co.kr'] },
      '제목',
      '<p>본문</p>',
      fake,
    );

    expect(seen!.url).toBe('https://api.resend.com/emails');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(seen!.init.body as string);
    expect(body.to).toEqual(['a@dlas.co.kr', 'b@dlas.co.kr']);
    expect(body.subject).toBe('제목');
  });

  it('실패하면 에러를 던진다', async () => {
    const fake: typeof fetch = async () => new Response('bad key', { status: 401 });
    await expect(
      sendEmail({ apiKey: 'k', from: 'f@x.com', to: ['t@x.com'] }, 's', 'h', fake),
    ).rejects.toThrow(/401.*bad key/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/notify.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/notify.ts`:

```ts
import type { SubmissionRow } from './db';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tableRow(label: string, value: string): string {
  return `<tr><th align="left" style="padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;color:#666">${escapeHtml(
    label,
  )}</th><td style="padding:6px 0">${value}</td></tr>`;
}

export function buildEmail(
  row: SubmissionRow,
  fileLinks: { filename: string; url: string }[],
): { subject: string; html: string } {
  const subject = `[${row.form_subject}] ${row.name} ${row.phone}`;

  const rows: string[] = [
    tableRow('성함', escapeHtml(row.name)),
    tableRow('연락처', escapeHtml(row.phone)),
  ];
  if (row.car) rows.push(tableRow('차종', escapeHtml(row.car)));
  if (row.methods.length > 0) rows.push(tableRow('구매방식', escapeHtml(row.methods.join(', '))));
  if (row.pay_period.length > 0) rows.push(tableRow('시기', escapeHtml(row.pay_period.join(', '))));
  if (row.message) {
    rows.push(tableRow('문의사항', escapeHtml(row.message).replace(/\n/g, '<br />')));
  }
  if (fileLinks.length > 0) {
    const links = fileLinks
      .map((f) => `<a href="${escapeHtml(f.url)}">${escapeHtml(f.filename)}</a>`)
      .join('<br />');
    rows.push(tableRow('첨부파일', `${links}<br /><small style="color:#999">링크는 7일 후 만료됩니다.</small>`));
  }
  if (row.ref) rows.push(tableRow('마케팅경로', escapeHtml(row.ref)));
  if (row.referer_page) rows.push(tableRow('이전페이지', escapeHtml(row.referer_page)));
  if (row.source_page) rows.push(tableRow('제출페이지', escapeHtml(row.source_page)));

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;font-size:14px;color:#222">
<h2 style="font-size:16px;margin:0 0 16px">${escapeHtml(row.form_subject)}</h2>
<table cellpadding="0" cellspacing="0">${rows.join('')}</table>
<p style="margin-top:24px;color:#999;font-size:12px">제출 ID: ${escapeHtml(row.id)}</p>
</div>`;

  return { subject, html };
}

export interface MailConfig {
  apiKey: string;
  from: string;
  to: string[];
}

export async function sendEmail(
  cfg: MailConfig,
  subject: string,
  html: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, html }),
  });

  if (!res.ok) {
    throw new Error(`resend failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/notify.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/notify.ts tests/forms/notify.test.ts
git commit -m "feat: 상담 알림 이메일 생성·발송"
```

---

### Task 9: Turnstile 검증 모듈

**Files:**
- Create: `src/lib/forms/turnstile.ts`
- Test: `tests/forms/turnstile.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `function verifyTurnstile(secret: string, token: string | null, ip: string | null, fetchImpl?: typeof fetch): Promise<boolean>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/forms/turnstile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from '../../src/lib/forms/turnstile';

describe('verifyTurnstile', () => {
  it('success:true면 통과다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 });
    expect(await verifyTurnstile('secret', 'token', '1.2.3.4', fake)).toBe(true);
  });

  it('success:false면 실패다', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      });
    expect(await verifyTurnstile('secret', 'token', null, fake)).toBe(false);
  });

  it('토큰이 없으면 API를 부르지 않고 실패다', async () => {
    let called = false;
    const fake: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    expect(await verifyTurnstile('secret', null, null, fake)).toBe(false);
    expect(await verifyTurnstile('secret', '', null, fake)).toBe(false);
    expect(called).toBe(false);
  });

  it('siteverify가 죽으면 실패로 본다', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('network down');
    };
    expect(await verifyTurnstile('secret', 'token', null, fake)).toBe(false);
  });

  it('IP가 있으면 remoteip로 함께 보낸다', async () => {
    let body: URLSearchParams | null = null;
    const fake: typeof fetch = async (_url, init) => {
      body = (init as RequestInit).body as URLSearchParams;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    await verifyTurnstile('secret', 'token', '9.9.9.9', fake);
    expect(body!.get('secret')).toBe('secret');
    expect(body!.get('response')).toBe('token');
    expect(body!.get('remoteip')).toBe('9.9.9.9');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/turnstile.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현한다**

`src/lib/forms/turnstile.ts`:

```ts
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string,
  token: string | null,
  ip: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    // siteverify에 닿지 못하면 통과시키지 않는다
    return false;
  }
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/turnstile.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/forms/turnstile.ts tests/forms/turnstile.test.ts
git commit -m "feat: Turnstile 검증"
```

---

### Task 10: 제출 엔드포인트

**Files:**
- Create: `src/pages/wp-json/contact-form-7/v1/contact-forms/[id]/feedback.ts`
- Create: `src/lib/forms/env.ts`
- Test: `tests/forms/env.test.ts`

**Interfaces:**
- Consumes: Task 2~9의 모든 모듈
- Produces: `POST /wp-json/contact-form-7/v1/contact-forms/{id}/feedback`, `interface FormsEnv`, `function readEnv(source: Record<string, unknown>): FormsEnv`

- [ ] **Step 1: 환경변수 판독기의 실패하는 테스트를 쓴다**

`tests/forms/env.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/env.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 환경변수 판독기를 구현한다**

`src/lib/forms/env.ts`:

```ts
export interface FormsEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  turnstileSecret: string;
  resendApiKey: string;
  notifyTo: string[];
  notifyFrom: string;
  fileTokenSecret: string;
  siteOrigin: string;
}

function required(source: Record<string, unknown>, name: string): string {
  const v = source[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`환경변수 ${name}가 설정되어 있지 않습니다.`);
  }
  return v.trim();
}

export function readEnv(source: Record<string, unknown>): FormsEnv {
  return {
    supabaseUrl: required(source, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(source, 'SUPABASE_SERVICE_ROLE_KEY'),
    turnstileSecret: required(source, 'TURNSTILE_SECRET'),
    resendApiKey: required(source, 'RESEND_API_KEY'),
    notifyTo: required(source, 'NOTIFY_TO')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    notifyFrom: required(source, 'NOTIFY_FROM'),
    fileTokenSecret: required(source, 'FILE_TOKEN_SECRET'),
    siteOrigin: required(source, 'PUBLIC_SITE_ORIGIN').replace(/\/+$/, ''),
  };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/env.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 제출 엔드포인트를 구현한다**

`src/pages/wp-json/contact-form-7/v1/contact-forms/[id]/feedback.ts`:

```ts
import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { findForm } from '../../../../../../lib/forms/definitions';
import { validateText, MSG_REQUIRED } from '../../../../../../lib/forms/validate';
import {
  MAX_FILE_BYTES, MAX_FILES, detectFileType, sanitizeFilename, r2Key,
  type AttachmentMeta,
} from '../../../../../../lib/forms/files';
import { FILE_TOKEN_TTL_MS, signFileToken, hashIp } from '../../../../../../lib/forms/token';
import { cf7Response } from '../../../../../../lib/forms/cf7';
import {
  insertSubmission, updateEmailStatus, type SubmissionRow,
} from '../../../../../../lib/forms/db';
import { buildEmail, sendEmail } from '../../../../../../lib/forms/notify';
import { verifyTurnstile } from '../../../../../../lib/forms/turnstile';
import { readEnv } from '../../../../../../lib/forms/env';

export const prerender = false;

const MSG_BAD_FILE = '허용되지 않는 파일 형식입니다. jpg, png, pdf만 첨부할 수 있습니다.';
const MSG_BIG_FILE = '파일 용량이 너무 큽니다. 10MB 이하만 첨부할 수 있습니다.';

export const POST: APIRoute = async ({ request, params }) => {
  const env = readEnv(cfEnv as unknown as Record<string, unknown>);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return cf7Response('unknown', 'spam');
  }

  const str = (name: string): string | null => {
    const v = form.get(name);
    return typeof v === 'string' ? v : null;
  };
  const strAll = (name: string): string[] =>
    form.getAll(name).filter((v): v is string => typeof v === 'string');

  // 1. 폼 판정. URL의 id와 본문의 _wpcf7이 다르면 조작으로 본다.
  const cf7Id = str('_wpcf7') ?? '';
  const containerPost = str('_wpcf7_container_post') ?? '';
  const def = findForm(cf7Id, containerPost);
  if (!def || def.cf7Id !== params.id) {
    return cf7Response(str('_wpcf7_unit_tag') ?? 'unknown', 'spam');
  }
  const unitTag = def.unitTag;

  const ip = request.headers.get('cf-connecting-ip');

  // 2. Turnstile
  const passed = await verifyTurnstile(env.turnstileSecret, str('cf-turnstile-response'), ip);
  if (!passed) return cf7Response(unitTag, 'spam');

  // 3. 텍스트 검증
  const text = validateText(def, str, strAll);
  const invalid = text.ok ? [] : [...text.invalid];

  // 4. 파일 검증
  const submissionId = crypto.randomUUID();
  const now = new Date();
  const pending: { n: number; meta: AttachmentMeta; body: ArrayBuffer }[] = [];

  let n = 0;
  for (const field of def.fileFields) {
    const entry = form.get(field);
    const isFile = entry instanceof File && entry.size > 0;

    if (!isFile) {
      if (def.requiredFields.includes(field)) {
        invalid.push({ field, message: MSG_REQUIRED });
      }
      continue;
    }
    if (n >= MAX_FILES) continue;
    if (entry.size > MAX_FILE_BYTES) {
      invalid.push({ field, message: MSG_BIG_FILE });
      continue;
    }

    const body = await entry.arrayBuffer();
    const type = detectFileType(new Uint8Array(body.slice(0, 8)));
    if (!type) {
      invalid.push({ field, message: MSG_BAD_FILE });
      continue;
    }

    n += 1;
    const filename = sanitizeFilename(entry.name);
    pending.push({
      n,
      body,
      meta: {
        n,
        filename,
        size: entry.size,
        content_type: type.mime,
        r2_key: r2Key(submissionId, n, filename, now),
      },
    });
  }

  if (invalid.length > 0) return cf7Response(unitTag, 'validation_failed', invalid);
  if (!text.ok) return cf7Response(unitTag, 'validation_failed', text.invalid);

  // 5. R2 먼저, DB 나중. 반대면 파일 없는 레코드가 생긴다.
  const bucket = (cfEnv as unknown as { FORM_UPLOADS: R2Bucket }).FORM_UPLOADS;
  try {
    for (const p of pending) {
      await bucket.put(p.meta.r2_key, p.body, {
        httpMetadata: { contentType: p.meta.content_type },
      });
    }
  } catch (err) {
    console.error('r2 put failed', err);
    return cf7Response(unitTag, 'mail_failed');
  }

  const row: SubmissionRow = {
    id: submissionId,
    form_key: def.key,
    form_subject: def.subject, // 클라이언트의 your-subject는 신뢰하지 않는다
    name: text.data.name,
    phone: text.data.phone,
    car: text.data.car,
    methods: text.data.methods,
    pay_period: text.data.payPeriod,
    message: text.data.message,
    ref: text.data.ref,
    referer_page: text.data.refererPage,
    source_page: request.headers.get('referer'),
    attachments: pending.map((p) => p.meta),
    email_sent_at: null,
    email_error: null,
    ip_hash: ip ? await hashIp(env.fileTokenSecret, ip) : null,
    user_agent: request.headers.get('user-agent'),
  };

  const supabase = { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey };
  try {
    await insertSubmission(supabase, row);
  } catch (err) {
    console.error('supabase insert failed', err);
    return cf7Response(unitTag, 'mail_failed');
  }

  // 6. 이메일. 여기서 실패해도 고객에게는 성공으로 응답한다.
  const exp = Date.now() + FILE_TOKEN_TTL_MS;
  const links = await Promise.all(
    pending.map(async (p) => ({
      filename: p.meta.filename,
      url: `${env.siteOrigin}/api/file/${submissionId}/${p.n}?t=${await signFileToken(
        env.fileTokenSecret,
        submissionId,
        p.n,
        exp,
      )}`,
    })),
  );

  const { subject, html } = buildEmail(row, links);
  try {
    await sendEmail(
      { apiKey: env.resendApiKey, from: env.notifyFrom, to: env.notifyTo },
      subject,
      html,
    );
    await updateEmailStatus(supabase, submissionId, {
      email_sent_at: new Date().toISOString(),
      email_error: null,
    });
  } catch (err) {
    // 알림 실패는 기록만 남기고 성공 응답을 유지한다. 리드를 잃는 것보다 낫다.
    console.error('email failed', err);
    await updateEmailStatus(supabase, submissionId, {
      email_sent_at: null,
      email_error: String(err).slice(0, 500),
    });
  }

  return cf7Response(unitTag, 'mail_sent');
};
```

- [ ] **Step 6: 타입 체크와 빌드가 통과하는지 확인한다**

Run: `npx astro check && npm run build`
Expected: 에러 없음. `dist/`의 HTML 파일 수가 여전히 32개인지 확인한다:

```bash
find dist -name "*.html" | sort > /tmp/dist-task10.txt
diff /tmp/dist-baseline.txt /tmp/dist-task10.txt && echo "SAME"
```

`R2Bucket` 타입이 없다는 에러가 나면 `npx wrangler types`를 실행해 `worker-configuration.d.ts`를 생성하고 `.gitignore`가 아니라 저장소에 커밋한다.

- [ ] **Step 7: 커밋**

```bash
git add src/lib/forms/env.ts tests/forms/env.test.ts "src/pages/wp-json" worker-configuration.d.ts
git commit -m "feat: CF7 제출 엔드포인트"
```

---

### Task 11: 첨부파일 다운로드 엔드포인트

**Files:**
- Modify: `src/lib/forms/db.ts`
- Modify: `tests/forms/db.test.ts`
- Create: `src/pages/api/file/[id]/[n].ts`

**Interfaces:**
- Consumes: `verifyFileToken` (Task 5), `readEnv` (Task 10), R2 바인딩 `FORM_UPLOADS`
- Produces:
  - `function fetchAttachments(cfg: SupabaseConfig, id: string, fetchImpl?: typeof fetch): Promise<AttachmentMeta[]>`
  - `GET /api/file/{submissionId}/{n}?t={token}`

R2 키에는 연·월과 파일명이 들어 있어 URL만으로는 알 수 없다. 버킷을 `list`로 훑는 방법은 객체가 쌓이면 1000개 한도에 걸리므로, 제출 레코드의 `attachments[].r2_key`를 Supabase에서 읽어 정확한 키를 얻는다.

- [ ] **Step 1: `fetchAttachments`의 실패하는 테스트를 쓴다**

`tests/forms/db.test.ts` 상단 import에 `fetchAttachments`를 추가하고, 파일 끝에 다음을 붙인다:

```ts
describe('fetchAttachments', () => {
  it('id로 좁혀 attachments만 조회한다', async () => {
    let seen = '';
    const fake: typeof fetch = async (url) => {
      seen = String(url);
      return new Response(
        JSON.stringify([
          {
            attachments: [
              { n: 1, filename: 'a.pdf', size: 1, content_type: 'application/pdf', r2_key: 'k' },
            ],
          },
        ]),
        { status: 200 },
      );
    };
    const out = await fetchAttachments(CFG, 'sub-1', fake);
    expect(seen).toContain('id=eq.sub-1');
    expect(seen).toContain('select=attachments');
    expect(out[0].r2_key).toBe('k');
  });

  it('레코드가 없으면 빈 배열이다', async () => {
    const fake: typeof fetch = async () => new Response('[]', { status: 200 });
    expect(await fetchAttachments(CFG, 'none', fake)).toEqual([]);
  });

  it('실패 응답이면 에러를 던진다', async () => {
    const fake: typeof fetch = async () => new Response('boom', { status: 500 });
    await expect(fetchAttachments(CFG, 'sub-1', fake)).rejects.toThrow(/500.*boom/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- tests/forms/db.test.ts`
Expected: FAIL — `fetchAttachments is not a function` 또는 import 에러

- [ ] **Step 3: `fetchAttachments`를 구현한다**

`src/lib/forms/db.ts` 끝에 추가한다:

```ts
export async function fetchAttachments(
  cfg: SupabaseConfig,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AttachmentMeta[]> {
  const base = cfg.url.replace(/\/+$/, '');
  const res = await fetchImpl(
    `${base}/rest/v1/contact_submissions?id=eq.${encodeURIComponent(id)}&select=attachments`,
    {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`supabase select failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as { attachments: AttachmentMeta[] }[];
  return rows[0]?.attachments ?? [];
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test -- tests/forms/db.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 다운로드 엔드포인트를 구현한다**

`src/pages/api/file/[id]/[n].ts`:

```ts
import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { verifyFileToken } from '../../../../lib/forms/token';
import { fetchAttachments } from '../../../../lib/forms/db';
import { readEnv } from '../../../../lib/forms/env';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params, url }) => {
  const env = readEnv(cfEnv as unknown as Record<string, unknown>);
  const id = params.id ?? '';
  const n = Number(params.n);
  const token = url.searchParams.get('t') ?? '';

  if (!UUID_RE.test(id) || !(n === 1 || n === 2)) {
    return new Response('Not found', { status: 404 });
  }

  const verdict = await verifyFileToken(env.fileTokenSecret, id, n, token, Date.now());
  if (verdict === 'expired') {
    return new Response('이 링크는 만료되었습니다. 담당자에게 재발급을 요청해 주세요.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (verdict === 'invalid') {
    // 존재 여부를 흘리지 않기 위해 만료와 다른 응답을 준다
    return new Response('Not found', { status: 404 });
  }

  const attachments = await fetchAttachments(
    { url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey },
    id,
  );
  const meta = attachments.find((a) => a.n === n);
  if (!meta) return new Response('Not found', { status: 404 });

  const bucket = (cfEnv as unknown as { FORM_UPLOADS: R2Bucket }).FORM_UPLOADS;
  const object = await bucket.get(meta.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': meta.content_type,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      'cache-control': 'private, no-store',
    },
  });
};
```

- [ ] **Step 6: 타입 체크와 빌드를 확인한다**

Run: `npx astro check && npm run build`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add src/pages/api src/lib/forms/db.ts tests/forms/db.test.ts
git commit -m "feat: 서명 링크 기반 첨부파일 다운로드"
```

---


### Task 12: Turnstile 위젯과 swv 스키마 배치

**Files:**
- Modify: `src/raw/analysis-body.html`
- Modify: `src/raw/consulting-new-car-body.html`
- Modify: `src/raw/consulting-used-car-body.html`
- Modify: `src/raw/consulting-detailing-body.html`
- Create: `public/wp-json/contact-form-7/v1/contact-forms/584/feedback/schema`
- Create: `public/wp-json/contact-form-7/v1/contact-forms/583/feedback/schema`
- Create: `public/wp-json/contact-form-7/v1/contact-forms/631/feedback/schema`
- Create: `public/_headers`

`src/pages/**/index.astro` 는 건드리지 않는다. 페이지는 `src/raw/*-body.html`을 그대로 주입하므로 raw 파일만 고치면 된다.

**Interfaces:**
- Consumes: Turnstile site key (공개값)
- Produces: 폼 4종에 `cf-turnstile-response` 필드가 실림

- [ ] **Step 1: Turnstile site key를 발급받는다**

Cloudflare 대시보드 → Turnstile → Add site. 도메인 `dlas.co.kr`, 위젯 모드 **Managed**. 발급된 **Site Key**(공개값)와 **Secret Key**를 받아둔다. Secret은 Task 13에서 `wrangler secret`으로 넣는다.

로컬 테스트용으로는 Cloudflare가 공개한 테스트 키를 쓴다: site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (항상 통과).

- [ ] **Step 2: 4개 폼에 위젯 스크립트와 컨테이너를 넣는다**

각 파일에서 submit 버튼 마크업을 찾는다:

```html
<input class="wpcf7-form-control wpcf7-submit has-spinner" type="submit" value="
```

이 `<input>`을 감싼 `<p>` 바로 **앞에** 다음을 삽입한다. `<SITE_KEY>`를 Step 1에서 받은 site key로 바꾼다.

```html
<div class="cf-turnstile" data-sitekey="<SITE_KEY>" data-language="ko" style="margin:0 0 16px"></div>
```

그리고 각 파일의 `</form>` 바로 뒤에 스크립트를 한 번 넣는다:

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

위젯이 `<form>` 내부에 있어야 CF7이 FormData를 만들 때 `cf-turnstile-response`가 자동으로 포함된다. `</form>` 밖에 두면 토큰이 전송되지 않는다.

- [ ] **Step 3: swv 스키마 파일을 만든다**

CF7 JS가 페이지 로드 시 GET 하는 경로다. 없으면 콘솔 에러가 난다.

`public/wp-json/contact-form-7/v1/contact-forms/584/feedback/schema`:

```json
{
  "version": "6.0.6",
  "locale": "ko_KR",
  "rules": [
    { "rule": "required", "field": "your-name", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-name", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "your-phone", "error": "입력란을 작성해 주세요." },
    { "rule": "minlength", "field": "your-phone", "threshold": 13, "error": "입력이 너무 짧습니다." },
    { "rule": "maxlength", "field": "your-phone", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "maxlength", "field": "your-message", "threshold": 2000, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "file-71", "error": "입력란을 작성해 주세요." },
    { "rule": "enum", "field": "file-71", "accept": [".jpg", ".jpeg", ".png", ".pdf"], "error": "허용되지 않는 파일 형식입니다." },
    { "rule": "enum", "field": "file-72", "accept": [".jpg", ".jpeg", ".png", ".pdf"], "error": "허용되지 않는 파일 형식입니다." }
  ]
}
```

`public/wp-json/contact-form-7/v1/contact-forms/583/feedback/schema`:

```json
{
  "version": "6.0.6",
  "locale": "ko_KR",
  "rules": [
    { "rule": "required", "field": "your-name", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-name", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "your-phone", "error": "입력란을 작성해 주세요." },
    { "rule": "minlength", "field": "your-phone", "threshold": 13, "error": "입력이 너무 짧습니다." },
    { "rule": "maxlength", "field": "your-phone", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "your-car", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-car", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "maxlength", "field": "your-message", "threshold": 2000, "error": "입력이 너무 깁니다." }
  ]
}
```

`public/wp-json/contact-form-7/v1/contact-forms/631/feedback/schema`:

```json
{
  "version": "6.0.6",
  "locale": "ko_KR",
  "rules": [
    { "rule": "required", "field": "your-name", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-name", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "your-telephone", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-telephone", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "required", "field": "your-car", "error": "입력란을 작성해 주세요." },
    { "rule": "maxlength", "field": "your-car", "threshold": 400, "error": "입력이 너무 깁니다." },
    { "rule": "maxlength", "field": "your-message", "threshold": 2000, "error": "입력이 너무 깁니다." }
  ]
}
```

- [ ] **Step 4: 확장자 없는 파일이 JSON으로 서빙되도록 헤더를 지정한다**

`public/_headers`:

```
/wp-json/contact-form-7/v1/contact-forms/*/feedback/schema
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=3600
```

- [ ] **Step 5: 빌드하고 확인한다**

```bash
npm run build
ls dist/wp-json/contact-form-7/v1/contact-forms/584/feedback/schema
grep -c "cf-turnstile" dist/analysis/index.html
```

Expected: schema 파일이 존재하고, `cf-turnstile` 문자열이 1회 이상 나온다. 4개 폼 페이지 각각에서 확인한다:

```bash
for p in analysis consulting-new-car consulting-used-car consulting-detailing; do
  echo -n "$p: "; grep -c "cf-turnstile" "dist/$p/index.html"
done
```

Expected: 각 2 (위젯 div 1 + 스크립트 URL 1)

- [ ] **Step 6: 커밋**

```bash
git add src/raw public/wp-json public/_headers
git commit -m "feat: 컨택폼에 Turnstile 위젯과 swv 스키마 추가"
```

---

### Task 13: Supabase 마이그레이션과 배포 설정

**Files:**
- Create: `supabase/migrations/0001_contact_submissions.sql`
- Create: `docs/deploy-forms.md`

**Interfaces:**
- Consumes: 전체
- Produces: 운영 배포 가능 상태

- [ ] **Step 1: 마이그레이션 SQL을 작성한다**

`supabase/migrations/0001_contact_submissions.sql`:

```sql
create table public.contact_submissions (
  id             uuid primary key,
  created_at     timestamptz not null default now(),
  form_key       text not null,
  form_subject   text not null,
  name           text not null,
  phone          text not null,
  car            text,
  methods        text[] not null default '{}',
  pay_period     text[] not null default '{}',
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
  user_agent     text,
  constraint contact_submissions_form_key_check check (
    form_key in ('analysis', 'consulting-new-car', 'consulting-used-car', 'consulting-detailing')
  )
);

create index contact_submissions_created_at_idx
  on public.contact_submissions (created_at desc);

create index contact_submissions_form_key_created_at_idx
  on public.contact_submissions (form_key, created_at desc);

-- RLS는 켜되 정책을 만들지 않는다. service role만 접근 가능해진다.
alter table public.contact_submissions enable row level security;

comment on table public.contact_submissions is
  'dlas.co.kr 컨택폼 제출. 첨부파일 실체는 Cloudflare R2 버킷 dlas-form-uploads에 있고 attachments.r2_key가 그 경로다.';
```

- [ ] **Step 2: Supabase에 적용한다**

Supabase 대시보드 → SQL Editor에 위 SQL을 붙여 실행한다. 실행 후 Table Editor에서 `contact_submissions` 테이블이 보이는지 확인한다.

- [ ] **Step 3: R2 버킷을 만든다**

```bash
npx wrangler r2 bucket create dlas-form-uploads
npx wrangler r2 bucket create dlas-form-uploads-preview
```

Cloudflare 대시보드 → R2 → `dlas-form-uploads` → Settings에서:
- **Public access는 켜지 않는다** (기본값 그대로).
- Object lifecycle rules → Add rule: 프리픽스 `submissions/`, 1095일(3년) 후 삭제.

- [ ] **Step 4: 시크릿을 등록한다**

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put NOTIFY_TO
npx wrangler secret put NOTIFY_FROM
npx wrangler secret put FILE_TOKEN_SECRET
npx wrangler secret put PUBLIC_SITE_ORIGIN
```

`FILE_TOKEN_SECRET`은 다음으로 생성한다:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`NOTIFY_FROM`은 Resend에서 도메인 인증을 마친 주소여야 한다. 인증 전에는 Resend가 발송을 거부한다.

- [ ] **Step 5: 로컬에서 통합 테스트한다**

`.dev.vars`를 만들고 (`.dev.vars.example` 복사) Turnstile은 테스트 키를 넣는다. 그 다음:

```bash
npm run build
npx wrangler dev
```

다른 터미널에서 제출을 흉내 낸다:

```bash
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/583/feedback' \
  -H 'Referer: http://localhost:8787/consulting-new-car/' \
  -F '_wpcf7=583' \
  -F '_wpcf7_container_post=580' \
  -F '_wpcf7_unit_tag=wpcf7-f583-p580-o1' \
  -F 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' \
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

필수 필드 누락 케이스도 확인한다:

```bash
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/583/feedback' \
  -F '_wpcf7=583' -F '_wpcf7_container_post=580' \
  -F 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' \
  -F 'your-name=' -F 'your-phone=' -F 'your-car='
```

Expected: `"status":"validation_failed"` 이고 `invalid_fields`에 세 필드가 모두 들어 있다.

첨부 테스트 (584):

```bash
printf '%%PDF-1.7\n' > /tmp/test.pdf
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/584/feedback' \
  -F '_wpcf7=584' -F '_wpcf7_container_post=609' \
  -F 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' \
  -F 'your-name=테스트' -F 'your-phone=010-1234-5678' \
  -F 'file-71=@/tmp/test.pdf'
```

Expected: `mail_sent`. 메일에 온 서명 링크를 브라우저로 열어 PDF가 내려받아지는지 확인한다.

위장 파일이 거부되는지 확인한다:

```bash
printf 'MZ\x90\x00' > /tmp/fake.png
curl -s -X POST \
  'http://localhost:8787/wp-json/contact-form-7/v1/contact-forms/584/feedback' \
  -F '_wpcf7=584' -F '_wpcf7_container_post=609' \
  -F 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' \
  -F 'your-name=테스트' -F 'your-phone=010-1234-5678' \
  -F 'file-71=@/tmp/fake.png'
```

Expected: `"status":"validation_failed"` 이고 메시지가 "허용되지 않는 파일 형식입니다..."

- [ ] **Step 6: WAF rate limit 규칙을 만든다**

Cloudflare 대시보드 → Security → WAF → Rate limiting rules → Create rule:
- 이름: `contact-form-submit`
- 매칭: `URI Path` starts with `/wp-json/contact-form-7/`
- 카운팅 기준: IP
- 임계값: 10분에 5회
- 동작: Block, 10분

- [ ] **Step 7: 배포 절차 문서를 쓴다**

`docs/deploy-forms.md`에 Step 1~6을 그대로 옮겨 적고, 다음 운영 메모를 덧붙인다:

```markdown
## 운영 메모

- 담당자는 Supabase Table Editor의 `contact_submissions`에서 제출을 본다.
  `created_at desc` 정렬이 기본이다.
- 첨부파일 링크는 발송 7일 후 만료된다. 만료 후에는 R2 대시보드에서
  `attachments[].r2_key` 경로를 직접 찾아 내려받는다.
- `email_error`가 채워진 레코드는 알림 메일이 실패한 건이다. 주기적으로 확인한다.
- R2 객체는 3년 후 자동 삭제된다. Supabase의 텍스트 레코드는 남는다.
- `crm_synced_at` / `crm_record_id`는 자체 CRM 연동 시 쓸 자리다. 지금은 항상 null이다.
- 기존 dl.dbmg.kr(Zmes) 전송은 이 구현에 포함되지 않았다.
  원본 WordPress가 살아 있는 동안에는 그쪽이 계속 받는다.
```

- [ ] **Step 8: 전체 테스트를 돌리고 커밋한다**

```bash
npm test
npm run build
git add supabase docs/deploy-forms.md
git commit -m "feat: Supabase 마이그레이션과 배포 절차 문서"
```

Expected: 모든 vitest 통과, 빌드 성공.

---

## 완료 확인

- [ ] `npm test` 전체 통과
- [ ] `npm run build` 후 `dist`의 HTML 파일이 32개이고 Task 1의 기준선과 동일
- [ ] 4개 폼 모두 실제 브라우저에서 제출 성공, Supabase에 레코드 생성
- [ ] 첨부 있는 `analysis` 폼 제출 시 R2에 객체 생성, 메일의 서명 링크로 다운로드 가능
- [ ] 필수 필드 누락 시 기존과 같은 위치에 빨간 인라인 에러가 뜬다
- [ ] Turnstile 실패 시 CF7 에러 메시지가 뜬다
- [ ] 만료된 서명 링크가 410을 반환한다

## 후속 과제 (이번 범위 밖)

- 자체 CRM 연동 (`crm_synced_at`, `crm_record_id` 활용)
- 개인정보 수집·이용 동의 체크박스 신설 — 원본 폼에 없다
- `file-71`의 라벨("선택")과 실제 검증(필수) 불일치 — 발주처 확인 후 한쪽으로 맞춘다
- `dl_ref` / `it_ref` / `referer-page`를 실제로 채우는 유입 추적 스크립트
- 만료된 파일 링크 셀프서비스 재발급
