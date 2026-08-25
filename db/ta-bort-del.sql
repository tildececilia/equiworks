-- ============================================================
--  EQUIWORKS – TA BORT EN DEL (JOURSCHEMA/RIDSKOLA) ELLER HELA STALLET
--  Knappen finns i delens inställningar och visas bara för den som
--  skapade stallet (org.owner_email). Här snävas behörigheten in så
--  att den gäller på riktigt: tidigare fick vilken admin som helst
--  radera en hel del.
--    stable_delete : bara ägaren (allt i delen försvinner via cascade)
--    org_del       : bara ägaren (tar med sig alla delar via cascade)
--  Kräver db/security.sql + db/org.sql + db/agare-mejlbyte.sql.
--  Säker att köra om. Kör i Supabase → SQL Editor → Run.
-- ============================================================

drop policy if exists stable_delete on stable;
create policy stable_delete on stable for delete
  using ( org_id is not null and is_org_owner(org_id) );

drop policy if exists org_del on org;
create policy org_del on org for delete
  using ( is_org_owner(id) );
