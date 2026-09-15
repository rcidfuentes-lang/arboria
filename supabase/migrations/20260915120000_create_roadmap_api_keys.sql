-- Claves de lectura del roadmap.
--
-- Una clave identifica un proyecto. La peticion no lleva identificador de
-- proyecto: quien tiene la clave de un roadmap no puede pedir ningun otro, y
-- compartir una clave comparte ese roadmap y nada mas. Eso evita ademas tener
-- que elegir entre los tres identificadores divergentes que hay hoy (el uuid de
-- la fila, el slug y document.project.id).
--
-- Nunca se guarda la clave: solo su SHA-256 en hexadecimal. Una copia de esta
-- tabla no permite leer ningun roadmap.

create table public.roadmap_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.roadmap_projects(id) on delete cascade,
  key_hash text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index roadmap_api_keys_project_id_idx on public.roadmap_api_keys (project_id);

alter table public.roadmap_api_keys enable row level security;

-- Las mismas cuatro politicas que roadmap_projects y por la misma condicion:
-- el dueño del proyecto. Sin politica para anon, de modo que para anon esta
-- tabla no tiene ninguna fila.

create policy "Users can read own roadmap api keys"
on public.roadmap_api_keys
for select
to authenticated
using (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

create policy "Users can create own roadmap api keys"
on public.roadmap_api_keys
for insert
to authenticated
with check (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

create policy "Users can update own roadmap api keys"
on public.roadmap_api_keys
for update
to authenticated
using (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

create policy "Users can delete own roadmap api keys"
on public.roadmap_api_keys
for delete
to authenticated
using (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

-- La unica puerta de lectura desde fuera.
--
-- Es security definer porque la RLS de roadmap_projects solo deja leer al dueño
-- autenticado, y quien pide el roadmap no es un usuario: es una clave. El
-- alcance de ese privilegio es exactamente una columna de una fila —el
-- documento del proyecto al que apunta la clave— y nada mas: ni owner_id, ni
-- slug, ni el uuid de la fila, ni las fechas, ni la tabla de claves.
--
-- Devuelve null cuando la clave no existe, esta revocada o su proyecto ya no
-- esta. Quien llama no puede distinguir los tres casos.
--
-- search_path vacio y todo cualificado, que es la forma dura de escribir una
-- funcion security definer. sha256 es el builtin de Postgres: no hace falta
-- pgcrypto ni ninguna extension.
create function public.roadmap_document_by_key(api_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select p.document
  from public.roadmap_api_keys k
  join public.roadmap_projects p on p.id = k.project_id
  where k.revoked_at is null
    and k.key_hash = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(api_key, 'UTF8')),
      'hex'
    )
  limit 1;
$$;

-- Por defecto Postgres concede execute a public, del que heredan anon y
-- authenticated. Se retira y se concede solo a anon, que es el rol con el que
-- llama el endpoint de lectura.
revoke all on function public.roadmap_document_by_key(text) from public;
grant execute on function public.roadmap_document_by_key(text) to anon;
