-- ============================================================
--  EQUIWORKS – KALENDERPRENUMERATION
--  Ger varje användare en hemlig token. Token ligger i länken
--  som klistras in i telefonens kalender, så kalendern kan
--  hämta passen utan att vara inloggad i appen.
--  Kör hela filen i Supabase → SQL Editor. Går att köra om.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists cal_token (
  email       text primary key,
  token       text not null unique,
  created_at  timestamptz not null default now()
);

-- Ingen får läsa tabellen direkt — bara funktionerna nedan och
-- edge-funktionen (som använder servicenyckeln) rör den.
alter table cal_token enable row level security;

-- Min egen token. Skapas första gången jag frågar efter den.
create or replace function my_cal_token()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_token text;
begin
  if v_email is null or v_email = '' then
    raise exception 'inte inloggad';
  end if;
  select token into v_token from cal_token where email = v_email;
  if v_token is null then
    v_token := encode(gen_random_bytes(18), 'hex');
    insert into cal_token(email, token) values (v_email, v_token)
      on conflict (email) do update set token = excluded.token
      returning token into v_token;
  end if;
  return v_token;
end;
$$;
grant execute on function my_cal_token() to authenticated;

-- Ny token om man vill stänga av den gamla länken.
create or replace function new_cal_token()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_token text := encode(gen_random_bytes(18), 'hex');
begin
  if v_email is null or v_email = '' then
    raise exception 'inte inloggad';
  end if;
  insert into cal_token(email, token) values (v_email, v_token)
    on conflict (email) do update set token = excluded.token, created_at = now();
  return v_token;
end;
$$;
grant execute on function new_cal_token() to authenticated;

-- Passen som hör till en token. Används av edge-funktionen.
-- Security definer, så den läser förbi RLS — men bara det som
-- tokenens ägare själv står bokad på.
create or replace function cal_bookings(p_token text)
returns table (
  booking_id   uuid,
  pass_date    date,
  start_time   text,
  pass_name    text,
  description  text,
  is_task      boolean,
  stable_name  text,
  profile_name text
)
language sql
security definer
set search_path = public, extensions
as $$
  select b.id, b.pass_date, p.start_time, p.name, p.description,
         coalesce(p.is_task, false), s.name, pr.name
  from cal_token t
  join profile_member pm on pm.email = t.email
  join booking b         on b.profile_id = pm.profile_id
  join pass_def p        on p.id = b.pass_id
  join profile pr        on pr.id = b.profile_id
  join stable s          on s.id = b.stable_id
  where t.token = p_token
    and b.pass_date >= (current_date - interval '60 days')
  order by b.pass_date, p.start_time nulls first;
$$;
-- Bara edge-funktionen (servicenyckeln) får köra uppslaget.
revoke execute on function cal_bookings(text) from public, anon, authenticated;
grant  execute on function cal_bookings(text) to service_role;
