-- ============================================================
--  EQUIWORKS – VILKA GRUPPER SOM ROTERAR I JOUREN
--  Alla grupper i stallet behöver inte ingå i jourrotationen.
--  in_rotation styr vilka som gör det; ordningen är gruppens
--  sort_order, och stable.rotation_offset avgör vem som börjar.
--  Ställs in under Inställningar → Schema → Jourordning.
--  Kräver db/schema.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table duty_group add column if not exists in_rotation boolean not null default true;
