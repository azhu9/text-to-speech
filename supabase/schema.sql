-- Read Aloud: cloud sync schema for Supabase.
-- Run once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again.

-- Every synced item (document, page of text, highlight, setting) is one row.
-- `data` holds the item as JSON; `seq` increases on every write so each
-- device can ask "what changed since I last looked?".
create sequence if not exists public.records_seq;

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null,          -- 'docs' | 'pages' | 'annotations' | 'settings'
  key        text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  seq        bigint      not null default nextval('public.records_seq'),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

create index if not exists records_user_seq on public.records (user_id, seq);

create or replace function public.records_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.seq := nextval('public.records_seq');
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists records_touch on public.records;
create trigger records_touch
before insert or update on public.records
for each row execute function public.records_touch();

-- Each person can only see and change their own rows.
alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Original PDF files, stored as files/<user id>/<document id>.pdf (private).
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

drop policy if exists "own files: read" on storage.objects;
create policy "own files: read" on storage.objects
  for select using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own files: add" on storage.objects;
create policy "own files: add" on storage.objects
  for insert with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own files: replace" on storage.objects;
create policy "own files: replace" on storage.objects
  for update using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own files: delete" on storage.objects;
create policy "own files: delete" on storage.objects
  for delete using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
