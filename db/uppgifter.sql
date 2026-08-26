-- ============================================================
--  EQUIWORKS – UPPGIFTER (PASS UTAN DATUM)
--  En uppgift är som ett pass, men hör till hela jourperioden i
--  stället för en viss dag — t.ex. "Städa sadelkammaren". Den
--  visas i en egen lista under schemat, tas av någon i jour-
--  gruppen precis som ett pass, har kategori och räknas med i
--  statistiken. Bokningen sparas på periodens första dag.
--  Kräver db/schema.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table pass_def add column if not exists is_task boolean not null default false;
