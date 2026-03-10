create table if not exists rdv_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  extrabat_client_id bigint,
  extrabat_rdv_id bigint,
  objet text,
  started_at timestamptz,
  ended_at timestamptz,
  created_by text,
  created_at timestamptz default now()
);

create index idx_rdv_logs_client on rdv_logs(client_id);
create index idx_rdv_logs_extrabat_rdv on rdv_logs(extrabat_rdv_id);
create index idx_rdv_logs_created_at on rdv_logs(created_at);

alter table rdv_logs enable row level security;

create policy "Authenticated users can read rdv_logs"
  on rdv_logs for select to authenticated using (true);

create policy "Authenticated users can insert rdv_logs"
  on rdv_logs for insert to authenticated with check (true);
