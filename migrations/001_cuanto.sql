-- Fork-only tables for the Cuanto Ads deployment (database `mcp`).
create table if not exists mcp_tokens (
  tenant_id uuid not null,
  user_key text not null,
  sealed_token text not null,
  kind text not null check (kind in ('user', 'system_user')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_key)
);

create table if not exists tenant_keys (
  key_hash text primary key,
  tenant_id uuid not null,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists call_log (
  at timestamptz not null default now(),
  tenant_id uuid,
  path text not null,
  http_status integer not null,
  meta_code integer
);

create index if not exists call_log_at on call_log (at);
