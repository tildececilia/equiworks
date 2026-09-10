-- ============================================================
--  EQUIWORKS – ELEVUPPGIFTER + HÄSTTAGGAR (ridskola)
--  Eleven får vikt, längd och bedömning i den skyddade
--  anteckningen (bara admin, ridlärare och egna målsmän ser den).
--  Hästar får taggar utöver sin kategori: en häst kan ha flera
--  taggar (storlek, bra på, mindre bra på …) och en tagg kan ha
--  regeln "max N lektioner per dag" som schemat varnar för.
--  Kräver db/behorigheter.sql och db/kategorier2.sql.
--  Säker att köra om. Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table rs_student_note add column if not exists weight_kg  numeric;
alter table rs_student_note add column if not exists height_cm  int;
alter table rs_student_note add column if not exists assessment text;

create table if not exists rs_horse_tag (
  id          uuid primary key default gen_random_uuid(),
  stable_id   uuid not null references stable(id) on delete cascade,
  name        text not null,
  description text,
  max_per_day int,                                 -- null = ingen regel
  sort_order  int  not null default 0
);
create table if not exists rs_horse_tag_link (
  horse_id uuid not null references rs_horse(id)     on delete cascade,
  tag_id   uuid not null references rs_horse_tag(id) on delete cascade,
  primary key (horse_id, tag_id)
);

create or replace function horse_school(hid uuid) returns uuid
language sql stable security definer set search_path = public as
$$ select stable_id from rs_horse where id = hid $$;

alter table rs_horse_tag      enable row level security;
alter table rs_horse_tag_link enable row level security;

drop policy if exists rsht_sel on rs_horse_tag; drop policy if exists rsht_ins on rs_horse_tag;
drop policy if exists rsht_upd on rs_horse_tag; drop policy if exists rsht_del on rs_horse_tag;
create policy rsht_sel on rs_horse_tag for select using ( is_school_member(stable_id) );
create policy rsht_ins on rs_horse_tag for insert with check ( is_school_teacher(stable_id) );
create policy rsht_upd on rs_horse_tag for update using ( is_school_teacher(stable_id) );
create policy rsht_del on rs_horse_tag for delete using ( is_school_teacher(stable_id) );

drop policy if exists rshtl_sel on rs_horse_tag_link; drop policy if exists rshtl_ins on rs_horse_tag_link;
drop policy if exists rshtl_del on rs_horse_tag_link;
create policy rshtl_sel on rs_horse_tag_link for select using ( is_school_member(horse_school(horse_id)) );
create policy rshtl_ins on rs_horse_tag_link for insert with check ( is_school_teacher(horse_school(horse_id)) );
create policy rshtl_del on rs_horse_tag_link for delete using ( is_school_teacher(horse_school(horse_id)) );
