-- 0002_crm_sync_columns.sql
--
-- 0001과 같은 원칙으로 `if not exists`를 쓰지 않는다. 다시 실행했을 때
-- "column already exists" 에러가 나는 것 자체가 "이미 적용됨"의 증거가 되도록
-- 두는 편이, 조용히 통과시켜 적용 여부를 알 수 없게 만드는 것보다 낫다.
-- 적용 절차는 0001과 동일하다: Supabase SQL Editor에 이 파일을 통째로 붙여 실행한다.
--
-- 왜 컬럼을 더 만드는가:
-- crm_synced_at / crm_record_id 두 개만으로는 "아직 못 보냄"과 "보냈지만 영구히 거절됨"을
-- 구분할 수 없다. 둘 다 crm_synced_at is null 로 보이기 때문이다. 그 구분이 없으면
-- 재전송 크론이 400·401·415처럼 다시 보내봐야 소용없는 건을 영원히 두드리게 된다.
-- crm_attempts로 시도 횟수를 세어 상한을 두고, crm_error로 마지막 실패 사유를 남긴다.
-- crm_error에는 상태코드와 짧은 요약만 들어간다(고객 PII·시크릿은 절대 넣지 않는다).

alter table public.contact_submissions
  add column crm_error           text,
  add column crm_attempts        integer not null default 0,
  add column crm_last_attempt_at timestamptz;

-- 재전송 크론의 조회 조건(미동기 + 시도 여유 있음 + 오래된 순) 전용 부분 인덱스.
create index contact_submissions_crm_pending_idx
  on public.contact_submissions (created_at asc)
  where crm_synced_at is null;

comment on column public.contact_submissions.crm_error is
  '마지막 CRM 전송 실패 사유 요약. 상태코드와 짧은 발췌만 담는다. 시크릿·고객 PII 금지.';
comment on column public.contact_submissions.crm_attempts is
  'CRM 전송 시도 누적 횟수. 상한에 도달하면 크론이 더 이상 집지 않는다.';
comment on column public.contact_submissions.crm_last_attempt_at is
  '마지막 CRM 전송 시도 시각. 성공·실패 무관하게 갱신한다.';
