-- 0003_dedupe_key.sql
--
-- 0001·0002와 같은 원칙으로 `if not exists`를 쓰지 않는다. 다시 실행했을 때
-- "already exists" 에러가 나는 것 자체가 "이미 적용됨"의 증거다.
-- 적용 절차도 동일하다: Supabase SQL Editor에 이 파일을 통째로 붙여 실행한다.
--
-- 왜 필요한가:
-- 전송 중에 제출 버튼을 연타하면 누른 횟수만큼 레코드와 CRM 리드가 생겼다.
-- 화면 쪽은 dl-submit-once.js가 막지만, 그것만으로는 부족하다 —
-- 탭을 두 개 열어두거나, 브라우저가 요청을 재시도하거나, 누군가 엔드포인트를
-- 직접 두드리면 여전히 중복이 들어온다. 연타는 거의 동시에 도착하므로
-- "먼저 조회하고 없으면 넣는다"는 방식으로는 경합을 막지 못한다.
-- 유일하게 확실한 방법은 DB의 유니크 제약이다.
--
-- dedupe_key = sha256(폼·이름·연락처·차종·구매방식·구매시기·문의내용·첨부목록 + 시간버킷).
-- 원문이 아니라 해시라 이 컬럼에는 고객 정보가 남지 않는다(ip_hash와 같은 원칙).
-- 시간버킷(10분)을 넣는 이유는 같은 사람이 나중에 똑같은 내용으로 다시 문의하는 것은
-- 정상적인 재문의이기 때문이다. 그건 다른 버킷이라 그대로 저장된다.
--
-- 기존 행은 dedupe_key가 null이라 제약을 받지 않는다(부분 인덱스).

alter table public.contact_submissions
  add column dedupe_key text;

create unique index contact_submissions_dedupe_key_idx
  on public.contact_submissions (dedupe_key)
  where dedupe_key is not null;

comment on column public.contact_submissions.dedupe_key is
  '중복 제출 차단용 해시. 제출 내용 + 10분 시간버킷의 sha256. 원문·PII는 담기지 않는다.';
