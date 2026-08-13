-- 0001_contact_submissions.sql
--
-- 이 파일은 스키마를 버전 관리하기 위한 기록이다. 의도적으로
-- `if not exists`를 쓰지 않았다: 이미 실행된 마이그레이션을 실수로
-- 건너뛰는 것을 방지하기보다, 아래 SQL을 다시 실행했을 때
-- "already exists" 에러가 난다면 그것 자체가 "이미 적용됨"의 증거가
-- 되도록 하기 위해서다. 즉 이 파일을 Supabase SQL Editor에 붙여
-- 실행해보는 것이 곧 적용 여부를 확인하는 절차다. 적용 여부는
-- docs/deploy-forms.md의 "마이그레이션 적용" 절을 따라 확인한다.

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
