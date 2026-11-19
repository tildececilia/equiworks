-- ============================================================
--  EQUIWORKS – SPECIALPERIODER I JOURSCHEMAT (jul/nyår m.m.)
--  Under en specialperiod är det ordinarie schemat pausat:
--   * ingen jourgrupp, inga måltal, ingen deadline/fördelning
--   * ett pass gäller en dag bara om det finns en rad i pass_date
--     (pass_id, pass_date) — de vanliga dagreglerna gäller inte
--   * veckor vars söndag ligger i perioden hoppas över i
--     rotationen (pause_rotation), så gruppen som stod på tur
--     får nästa vanliga helg i stället
--   * schemat visar en egen statistik för perioden, alla profiler
--  Kräver db/passregler.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

create table if not exists special_period (
  id             uuid primary key default gen_random_uuid(),
  stable_id      uuid not null references stable(id) on delete cascade,
  name           text not null,
  start_date     date not null,
  end_date       date not null,
  pause_rotation boolean not null default true,
  created_at     timestamptz not null default now()
);

alter table special_period enable row level security;
drop policy if exists sp_sel on special_period; drop policy if exists sp_ins on special_period;
drop policy if exists sp_upd on special_period; drop policy if exists sp_del on special_period;
create policy sp_sel on special_period for select using ( is_stable_member(stable_id) );
create policy sp_ins on special_period for insert with check ( is_stable_admin(stable_id) );
create policy sp_upd on special_period for update using ( is_stable_admin(stable_id) );
create policy sp_del on special_period for delete using ( is_stable_admin(stable_id) );
