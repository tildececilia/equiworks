-- ============================================================
--  EQUIWORKS – ARBETSPASS: FLERA DAGAR, ENGÅNGSPASS, UPPGIFTER
--  Ett arbetspass kan gälla flera veckodagar (mån–fre i ett
--  pass) eller bara ett enda datum (task_date — skapas när man
--  kopierar ett pass och klistrar in det på en dag). Pass kan ha
--  uppgifter ("Mocka alla boxar") som valfritt tilldelas någon
--  på passet och bockas av per datum.
--  Kräver db/arbetspass.sql och db/behorigheter.sql.
--  Säker att köra om. Kör i Supabase → SQL Editor → Run.
-- ============================================================

alter table rs_task add column if not exists weekdays  int[];    -- null = bara weekday
alter table rs_task add column if not exists task_date date;     -- satt = gäller bara det datumet

create table if not exists rs_task_item (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references rs_task(id) on delete cascade,
  name       text not null,
  staff_id   uuid references rs_staff(id) on delete set null,   -- null = vem som helst på passet
  sort_order int  not null default 0
);
create table if not exists rs_task_item_done (
  item_id   uuid not null references rs_task_item(id) on delete cascade,
  work_date date not null,
  done_by   text,
  primary key (item_id, work_date)
);

create or replace function task_item_school(iid uuid) returns uuid
language sql stable security definer set search_path = public as
$$ select t.stable_id from rs_task_item i join rs_task t on t.id = i.task_id where i.id = iid $$;

alter table rs_task_item      enable row level security;
alter table rs_task_item_done enable row level security;

drop policy if exists rsti_sel on rs_task_item; drop policy if exists rsti_ins on rs_task_item;
drop policy if exists rsti_upd on rs_task_item; drop policy if exists rsti_del on rs_task_item;
create policy rsti_sel on rs_task_item for select using ( is_school_member(task_school(task_id)) );
create policy rsti_ins on rs_task_item for insert with check ( is_school_chef(task_school(task_id)) );
create policy rsti_upd on rs_task_item for update using ( is_school_chef(task_school(task_id)) );
create policy rsti_del on rs_task_item for delete using ( is_school_chef(task_school(task_id)) );

-- alla i ridskolan får bocka av (den som jobbar passet är sällan chef)
drop policy if exists rstid_sel on rs_task_item_done; drop policy if exists rstid_ins on rs_task_item_done;
drop policy if exists rstid_del on rs_task_item_done;
create policy rstid_sel on rs_task_item_done for select using ( is_school_member(task_item_school(item_id)) );
create policy rstid_ins on rs_task_item_done for insert with check ( is_school_member(task_item_school(item_id)) );
create policy rstid_del on rs_task_item_done for delete using ( is_school_member(task_item_school(item_id)) );
