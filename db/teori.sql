-- ============================================================
--  EQUIWORKS – TEORILEKTIONER + PLATS PER TILLFÄLLE
--  En lektion kan ha teori: aldrig, "ridläraren markerar själv"
--  eller regelbundet var N:e gång räknat från ett valt datum
--  (datumet styr också jämna/udda veckor). Varje enskilt
--  tillfälle kan ändras (teori ja/nej, annan plats) i schemats
--  panel — det sparas i rs_lesson_note tillsammans med
--  planeringen. Ridlärare får skriva i rs_lesson_note.
--  Kräver db/planering.sql, db/platser.sql, db/behorigheter.sql.
--  Säker att köra om. Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table rs_group add column if not exists theory_mode     text not null default 'none';   -- none | manual | regular
alter table rs_group add column if not exists theory_every    int  not null default 4;        -- var N:e gång
alter table rs_group add column if not exists theory_from     date;                           -- nästa/första teorilektion
alter table rs_group add column if not exists theory_place_id uuid references rs_place(id) on delete set null;

alter table rs_lesson_note add column if not exists theory   boolean;                          -- null = följer lektionens regel
alter table rs_lesson_note add column if not exists place_id uuid references rs_place(id) on delete set null;
alter table rs_lesson_note alter column note drop not null;

-- Ridlärare (inte bara admin) får skriva planering och tillfällesinställningar
drop policy if exists rsln_ins on rs_lesson_note; drop policy if exists rsln_upd on rs_lesson_note; drop policy if exists rsln_del on rs_lesson_note;
create policy rsln_ins on rs_lesson_note for insert with check ( is_school_teacher(group_school(group_id)) );
create policy rsln_upd on rs_lesson_note for update using ( is_school_teacher(group_school(group_id)) );
create policy rsln_del on rs_lesson_note for delete using ( is_school_teacher(group_school(group_id)) );
