-- ============================================================================
-- Mission WhiteCoat Lite v0.9 — Supabase Database Schema
-- ============================================================================
-- Run this entire file once in the Supabase SQL Editor (Project > SQL Editor).
-- It is safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE / DROP
-- IF EXISTS guards, so re-running will not create duplicates or error out.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- ---------------------------------------------------------------------------
-- admins
-- One row per admin. The primary key is the SAME uuid as the corresponding
-- row in Supabase's built-in auth.users table, so an admin's identity and
-- their login credentials are always in lock-step.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text,
  role        text not null default 'admin' check (role in ('admin', 'super_admin')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- players
-- name_key is a normalized (trimmed + lowercased) copy of the name, used to
-- silently ignore duplicates during bulk import.
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) > 0),
  name_key    text generated always as (lower(trim(name))) stored,
  created_at  timestamptz not null default now(),
  unique (name_key)
);

-- ---------------------------------------------------------------------------
-- battle_days
-- One row per calendar date. participant_ids holds the uuids of the players
-- who are "Today's Participants" for that date. status tracks the overall
-- workflow state shown on the Dashboard.
-- ---------------------------------------------------------------------------
create table if not exists public.battle_days (
  id               uuid primary key default gen_random_uuid(),
  date             date not null unique,
  status           text not null default 'not_generated'
                     check (status in ('not_generated', 'battles_generated', 'results_published')),
  participant_ids  uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- battle_matches
-- One row per battle (1v1 or the single 1v1v1) for a given battle_day.
-- `players` is a JSONB array of objects:
--   { "player_id": "<uuid>", "name": "<text>", "hours": <number|null>, "result": "winner"|"loser"|"draw"|null }
-- Keeping the player list as JSONB (instead of a separate join table) keeps
-- the schema to exactly the 5 tables required while remaining fully queryable.
-- ---------------------------------------------------------------------------
create table if not exists public.battle_matches (
  id             uuid primary key default gen_random_uuid(),
  battle_day_id  uuid not null references public.battle_days(id) on delete cascade,
  match_order    integer not null,
  players        jsonb not null default '[]'::jsonb,
  locked         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_battle_matches_day on public.battle_matches(battle_day_id);

-- ---------------------------------------------------------------------------
-- battle_results
-- A permanent, immutable snapshot taken at the moment "Publish Results" is
-- clicked. This is what the History screen reads from, so history remains
-- accurate even if the underlying battle_matches rows are later touched.
-- `battles` mirrors the shape of battle_matches.players but frozen in time.
-- ---------------------------------------------------------------------------
create table if not exists public.battle_results (
  id             uuid primary key default gen_random_uuid(),
  battle_day_id  uuid not null unique references public.battle_days(id) on delete cascade,
  date           date not null,
  battles        jsonb not null,
  published_at   timestamptz not null default now()
);

create index if not exists idx_battle_results_date on public.battle_results(date desc);

-- ============================================================================
-- 2. UPDATED_AT MAINTENANCE
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_battle_days_updated_at on public.battle_days;
create trigger trg_battle_days_updated_at
  before update on public.battle_days
  for each row execute function public.set_updated_at();

drop trigger if exists trg_battle_matches_updated_at on public.battle_matches;
create trigger trg_battle_matches_updated_at
  before update on public.battle_matches
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 3. AUTO-PROVISION ADMIN ROW ON NEW AUTH USER
-- ============================================================================
-- Workflow to create a new admin:
--   1. In Supabase Dashboard > Authentication > Users, click "Add user" and
--      set an email + password (or invite by email).
--   2. This trigger automatically creates a matching row in public.admins.
--   3. That's it — the new admin can log in immediately from the app.
-- ============================================================================

create or replace function public.handle_new_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admins (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_admin();

-- ============================================================================
-- 4. HELPER: is_admin()
-- ============================================================================
-- SECURITY DEFINER lets this function read public.admins even though the
-- calling user's own RLS policy on admins only allows them to see their own
-- row. It simply answers: "is the currently logged-in user an admin?"
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.admins where id = auth.uid()
  );
$$;

-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================

alter table public.admins         enable row level security;
alter table public.players        enable row level security;
alter table public.battle_days    enable row level security;
alter table public.battle_matches enable row level security;
alter table public.battle_results enable row level security;

-- ---------------------------------------------------------------------------
-- admins: a logged-in admin may view their own profile row only.
-- No client-side insert/update/delete — admins are provisioned only via the
-- trigger above (i.e. only via the Supabase Dashboard / service role).
-- ---------------------------------------------------------------------------
drop policy if exists "admins_select_own" on public.admins;
create policy "admins_select_own"
  on public.admins for select
  using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- players: full CRUD for any authenticated admin.
-- ---------------------------------------------------------------------------
drop policy if exists "players_select" on public.players;
create policy "players_select" on public.players for select using (public.is_admin());

drop policy if exists "players_insert" on public.players;
create policy "players_insert" on public.players for insert with check (public.is_admin());

drop policy if exists "players_update" on public.players;
create policy "players_update" on public.players for update using (public.is_admin());

drop policy if exists "players_delete" on public.players;
create policy "players_delete" on public.players for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- battle_days: full CRUD for any authenticated admin.
-- ---------------------------------------------------------------------------
drop policy if exists "battle_days_select" on public.battle_days;
create policy "battle_days_select" on public.battle_days for select using (public.is_admin());

drop policy if exists "battle_days_insert" on public.battle_days;
create policy "battle_days_insert" on public.battle_days for insert with check (public.is_admin());

drop policy if exists "battle_days_update" on public.battle_days;
create policy "battle_days_update" on public.battle_days for update using (public.is_admin());

drop policy if exists "battle_days_delete" on public.battle_days;
create policy "battle_days_delete" on public.battle_days for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- battle_matches: full CRUD for any authenticated admin.
-- ---------------------------------------------------------------------------
drop policy if exists "battle_matches_select" on public.battle_matches;
create policy "battle_matches_select" on public.battle_matches for select using (public.is_admin());

drop policy if exists "battle_matches_insert" on public.battle_matches;
create policy "battle_matches_insert" on public.battle_matches for insert with check (public.is_admin());

drop policy if exists "battle_matches_update" on public.battle_matches;
create policy "battle_matches_update" on public.battle_matches for update using (public.is_admin());

drop policy if exists "battle_matches_delete" on public.battle_matches;
create policy "battle_matches_delete" on public.battle_matches for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- battle_results: full CRUD for any authenticated admin.
-- ---------------------------------------------------------------------------
drop policy if exists "battle_results_select" on public.battle_results;
create policy "battle_results_select" on public.battle_results for select using (public.is_admin());

drop policy if exists "battle_results_insert" on public.battle_results;
create policy "battle_results_insert" on public.battle_results for insert with check (public.is_admin());

drop policy if exists "battle_results_update" on public.battle_results;
create policy "battle_results_update" on public.battle_results for update using (public.is_admin());

drop policy if exists "battle_results_delete" on public.battle_results;
create policy "battle_results_delete" on public.battle_results for delete using (public.is_admin());

-- ============================================================================
-- 6. REALTIME
-- ============================================================================
-- Add the tables the frontend subscribes to into the supabase_realtime
-- publication so postgres_changes events are broadcast to connected clients.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'battle_days'
  ) then
    alter publication supabase_realtime add table public.battle_days;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'battle_matches'
  ) then
    alter publication supabase_realtime add table public.battle_matches;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'battle_results'
  ) then
    alter publication supabase_realtime add table public.battle_results;
  end if;
end $$;

-- ============================================================================
-- DONE. Next step: create your first admin in Authentication > Users, then
-- log in to Mission WhiteCoat Lite with that email + password.
-- ============================================================================
