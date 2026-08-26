-- ============================================================
--  EQUIWORKS – DEADLINE, PASSLÄPP MED FÖRTUR OCH CHATTRENSNING
--  1) deadline_days: så här många dagar innan perioden (vecka
--     eller månad) börjar ska alla pass vara tagna. Är de inte
--     det får gruppen en varning i schemat och i klockan.
--  2) release_days: passen öppnar för bokning så här många dagar
--     innan perioden börjar. Tomt = öppna hela tiden, som förut.
--     release_rotation: rullande förtur — en häst i taget får
--     välja, release_hours timmar var, i en ordning som flyttas
--     fram ett steg varje period. När alla hästar i jourgruppen
--     haft sin tur öppnas passen för alla i stallet.
--  3) prune_chat: chattmeddelanden äldre än 60 dagar tas bort.
--  Kräver db/schema.sql + db/chat.sql. Säker att köra om.
--  Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table stable add column if not exists deadline_days    int;
alter table stable add column if not exists release_days     int;
alter table stable add column if not exists release_rotation boolean not null default false;
alter table stable add column if not exists release_hours    int not null default 24;

-- ---------- Chatten sparar 60 dagar ----------
--  Anropas av appen när chatten öppnas. security definer, så att
--  vem som helst i stallet kan städa utan att kunna radera nyare
--  meddelanden (funktionen tar bara bort det som är för gammalt).
create or replace function prune_chat(p_stable uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_stable_member(p_stable) then
    return;
  end if;
  delete from chat_message
   where stable_id = p_stable
     and created_at < now() - interval '60 days';
end $$;
grant execute on function prune_chat(uuid) to anon, authenticated;
