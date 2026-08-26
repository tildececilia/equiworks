-- ============================================================
--  EQUIWORKS – EGNA KATEGORIER FÖR UPPGIFTER
--  Uppgifter ska inte dela kategorier med passen. for_task
--  skiljer dem åt: false = kategori för pass (som förut),
--  true = kategori för uppgifter.
--  Kräver db/schema.sql + db/uppgifter.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table category add column if not exists for_task boolean not null default false;
