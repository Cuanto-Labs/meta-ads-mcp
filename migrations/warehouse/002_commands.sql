-- Applies to the `warehouse` database (WAREHOUSE_URL), not the fork's `mcp` database.
-- Kept in a subfolder so runMigrations() on the mcp database never picks it up.
create schema if not exists ops;

create table if not exists ops.meta_commands (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by text,
  kind text not null check (kind in ('campaign_status', 'adset_status', 'ad_status', 'adset_daily_budget')),
  target_id text not null,
  meta_account_id text not null,
  value text not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed', 'rejected')),
  result text,
  done_at timestamptz,
  started_at timestamptz,
  attempts integer not null default 0
);

create index if not exists meta_commands_queued on ops.meta_commands (id) where state = 'queued';
create index if not exists meta_commands_running on ops.meta_commands (started_at) where state = 'running';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'metabase_actions') then
    create role metabase_actions login;
  end if;
end $$;

revoke all on schema ops from metabase_actions;
grant usage on schema ops to metabase_actions;
revoke all on ops.meta_commands from metabase_actions;
grant insert, select on ops.meta_commands to metabase_actions;
grant usage on sequence ops.meta_commands_id_seq to metabase_actions;
