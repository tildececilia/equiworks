-- ============================================================
--  EQUIWORKS – STALL UTAN GRUPPER OCH UTAN PERIODER
--  Alla stall delar inte in sig i grupper som turas om, och alla
--  jobbar inte i perioder. Två inställningar styr det:
--    use_groups      true  = grupper turas om jouren (som förut)
--                    false = alla bokar tillsammans
--    rotation_basis  'week'  = ny period varje vecka (som förut)
--                    'month' = ny period varje månad
--                    'none'  = löpande, inga perioder alls
--  Med 'none' finns varken deadline, passläpp eller turordning —
--  schemat är helt enkelt öppet och man skriver upp sig löpande.
--  Kräver db/schema.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table stable add column if not exists use_groups boolean not null default true;
