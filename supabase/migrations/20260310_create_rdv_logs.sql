-- rdv_logs: log des rendez-vous créés via l'agent ou CreateAptModal
-- Contrainte unique sur extrabat_rdv_id pour éviter les doublons
create table if not exists rdv_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete
  set null,
    extrabat_client_id integer,
    -- aligné avec clients.extrabat_id (int4)
    extrabat_rdv_id integer unique,
    -- unique pour éviter les doublons
    objet text,
    started_at timestamptz,
    ended_at timestamptz,
    created_by text,
    -- code extrabat de l'utilisateur (ex: "46516")
    created_at timestamptz default now()
);
create index if not exists idx_rdv_logs_client on rdv_logs(client_id);
create index if not exists idx_rdv_logs_extrabat_rdv on rdv_logs(extrabat_rdv_id);
create index if not exists idx_rdv_logs_created_at on rdv_logs(created_at);
alter table rdv_logs enable row level security;
-- Policies idempotentes (drop if exists avant create)
do $$ begin drop policy if exists "Authenticated users can read rdv_logs" on rdv_logs;
drop policy if exists "Authenticated users can insert rdv_logs" on rdv_logs;
drop policy if exists "Authenticated users can update rdv_logs" on rdv_logs;
end $$;
create policy "Authenticated users can read rdv_logs" on rdv_logs for
select to authenticated using (true);
create policy "Authenticated users can insert rdv_logs" on rdv_logs for
insert to authenticated with check (true);
create policy "Authenticated users can update rdv_logs" on rdv_logs for
update to authenticated using (true);