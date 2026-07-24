create table public.roadmap_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, slug)
);

alter table public.roadmap_projects enable row level security;

create policy "Users can read own roadmap projects"
on public.roadmap_projects
for select
to authenticated
using (owner_id = auth.uid());

create policy "Users can create own roadmap projects"
on public.roadmap_projects
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Users can update own roadmap projects"
on public.roadmap_projects
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Users can delete own roadmap projects"
on public.roadmap_projects
for delete
to authenticated
using (owner_id = auth.uid());
