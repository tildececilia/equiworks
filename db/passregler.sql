-- ============================================================
--  EQUIWORKS – FLER PASSREGLER, SPECIALPASS OCH BESKRIVNINGAR
--  1) Stallet kan rotera jouren per vecka eller per kalendermånad.
--  2) Pass kan återkomma på fler sätt än idag:
--       day_rule    all | weekday | weekend | weekdays | monthday | nth
--       week_parity all | even | odd      (varannan vecka)
--       weekdays    [1..7] mån=1          (valda veckodagar, även för 'nth')
--       month_days  [1..31]               (t.ex. den 1:a varje månad)
--       nth_week    1..5                  (t.ex. första tisdagen i månaden)
--  3) Specialpass (is_special) gäller enskilda datum i pass_date,
--     t.ex. påsk, och kan begränsas till vissa grupper i pass_group.
--  4) Pass kan ha en beskrivning som visas i schemat.
--  Kräver db/schema.sql + db/security.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table stable   add column if not exists rotation_basis text not null default 'week';  -- week | month
alter table pass_def add column if not exists description  text;
alter table pass_def add column if not exists week_parity  text not null default 'all';     -- all | even | odd
alter table pass_def add column if not exists month_days   int[];
alter table pass_def add column if not exists nth_week     int;
alter table pass_def add column if not exists is_special   boolean not null default false;

create or replace function pass_stable(pid uuid) returns uuid
language sql stable security definer set search_path = public as
$$ select stable_id from pass_def where id = pid $$;

-- ---------- Datum för specialpass ----------
create table if not exists pass_date (
  pass_id   uuid not null references pass_def(id) on delete cascade,
  pass_date date not null,
  primary key (pass_id, pass_date)
);
alter table pass_date enable row level security;
drop policy if exists pd_sel on pass_date; drop policy if exists pd_ins on pass_date; drop policy if exists pd_del on pass_date;
create policy pd_sel on pass_date for select using ( is_stable_member(pass_stable(pass_id)) );
create policy pd_ins on pass_date for insert with check ( is_stable_admin(pass_stable(pass_id)) );
create policy pd_del on pass_date for delete using ( is_stable_admin(pass_stable(pass_id)) );

-- ---------- Grupper som får ta ett visst pass ----------
--  Inga rader = passet är öppet för alla (som idag).
create table if not exists pass_group (
  pass_id  uuid not null references pass_def(id)    on delete cascade,
  group_id uuid not null references duty_group(id)  on delete cascade,
  primary key (pass_id, group_id)
);
alter table pass_group enable row level security;
drop policy if exists pg_sel on pass_group; drop policy if exists pg_ins on pass_group; drop policy if exists pg_del on pass_group;
create policy pg_sel on pass_group for select using ( is_stable_member(pass_stable(pass_id)) );
create policy pg_ins on pass_group for insert with check ( is_stable_admin(pass_stable(pass_id)) );
create policy pg_del on pass_group for delete using ( is_stable_admin(pass_stable(pass_id)) );
