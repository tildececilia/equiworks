-- ============================================================
--  EQUIWORKS – GEMENSAM CHATT FÖR STALL UTAN GRUPPER
--  Chatten har hittills funnits per jourgrupp. Stall där alla
--  bokar tillsammans har inga grupper, och ska i stället ha en
--  enda chatt för hela stallet.
--  Lösning: chat_message.group_id får vara tomt. Tomt = stallets
--  gemensamma chatt, och då gäller medlemskap i stallet i stället
--  för medlemskap i gruppen.
--  Kräver db/chat.sql + db/lopande.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table chat_message alter column group_id drop not null;

drop policy if exists cmsg_select on chat_message;
drop policy if exists cmsg_insert on chat_message;

-- läsa: gruppchatt → gruppens medlemmar, stallchatt → alla i stallet
create policy cmsg_select on chat_message for select
  using ( case when group_id is null then is_stable_member(stable_id)
               else is_chat_member(group_id) end );

-- skriva: samma regel, och avsändaren måste vara en av mina egna profiler
create policy cmsg_insert on chat_message for insert
  with check ( is_profile_member(profile_id)
               and case when group_id is null then is_stable_member(stable_id)
                        else is_chat_member(group_id) end );
