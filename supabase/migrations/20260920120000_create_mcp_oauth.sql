-- Servidor de autorizacion OAuth 2.1 para el conector MCP de Arboria.
--
-- Por que hay OAuth y no una clave fija como en /api/roadmap: los conectores
-- personalizados de claude.ai solo admiten servidores sin autenticacion o con
-- OAuth. Sin autenticacion el roadmap seria publico. No es una preferencia, es
-- lo unico que deja el cliente.
--
-- Las tres tablas siguen el mismo patron que roadmap_api_keys y por las mismas
-- razones: nunca se guarda una credencial, solo su SHA-256 en hexadecimal. Una
-- copia de estas tablas no abre ninguna sesion y no lee ningun roadmap.
--
-- Las tres tienen RLS activada y ninguna politica. Eso no es un olvido: es la
-- forma de decir que no se llega a ellas por PostgREST ni como anon ni como
-- usuario autenticado. Todo el acceso pasa por las funciones security definer
-- de abajo, cada una con un alcance nombrado y un grant explicito.
--
-- Un token queda atado a un proyecto, igual que una clave de lectura. Quien
-- autoriza el conector para Songplay lee Songplay y ningun otro proyecto, y la
-- peticion MCP no lleva identificador de proyecto.

-- --------------------------------------------------------------------------
-- Tablas
-- --------------------------------------------------------------------------

-- Clientes dados de alta por registro dinamico (RFC 7591). Son clientes
-- publicos: no hay secreto que guardar porque no hay secreto. Lo que protege
-- el codigo de autorizacion es PKCE, no un secreto compartido.
create table public.mcp_oauth_clients (
  client_id uuid primary key default gen_random_uuid(),
  client_name text not null,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

alter table public.mcp_oauth_clients enable row level security;

-- Codigos de autorizacion. Viven cinco minutos y se consumen una sola vez.
--
-- owner_id se guarda ademas de project_id para dejar escrito quien autorizo:
-- si el proyecto cambiara de dueño, el rastro no se pierde.
create table public.mcp_oauth_codes (
  code_hash text primary key,
  client_id uuid not null references public.mcp_oauth_clients(client_id) on delete cascade,
  project_id uuid not null references public.roadmap_projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index mcp_oauth_codes_expires_at_idx on public.mcp_oauth_codes (expires_at);

alter table public.mcp_oauth_codes enable row level security;

-- Tokens. Cada canje de codigo abre una cadena (chain_id) y cada renovacion
-- añade un eslabon. La cadena existe para poder revocarla entera cuando se
-- detecta que alguien reutiliza un refresh token ya rotado, que es la señal de
-- que ese refresh token se ha filtrado.
--
-- refresh_expires_at no se alarga al renovar: se hereda del primer eslabon.
-- Asi una autorizacion caduca de verdad y hay que volver a concederla, en vez
-- de durar para siempre mientras nadie la revoque.
create table public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  chain_id uuid not null,
  code_hash text not null,
  client_id uuid not null references public.mcp_oauth_clients(client_id) on delete cascade,
  project_id uuid not null references public.roadmap_projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  resource text not null,
  access_token_hash text not null unique,
  refresh_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index mcp_oauth_tokens_chain_id_idx on public.mcp_oauth_tokens (chain_id);
create index mcp_oauth_tokens_code_hash_idx on public.mcp_oauth_tokens (code_hash);

alter table public.mcp_oauth_tokens enable row level security;

-- La RLS sin politicas ya deja estas tablas sin ninguna fila visible para anon
-- y para authenticated. Retirar ademas los privilegios de tabla lo dice dos
-- veces y con otras palabras: aqui no se entra por PostgREST.
revoke all on table public.mcp_oauth_clients from anon, authenticated;
revoke all on table public.mcp_oauth_codes from anon, authenticated;
revoke all on table public.mcp_oauth_tokens from anon, authenticated;

-- --------------------------------------------------------------------------
-- Registro dinamico de clientes
-- --------------------------------------------------------------------------

-- El registro dinamico es publico por especificacion: el cliente no tiene
-- forma de autenticarse todavia. Registrarse no da acceso a nada; el acceso lo
-- da Ruben en la pantalla de autorizacion. Aun asi hay un tope por hora, para
-- que una alta masiva no llene la tabla.
--
-- Solo se admiten redirecciones https, o http contra localhost, que es lo que
-- exige OAuth 2.1 y lo que necesita un cliente MCP de escritorio para probar.
create function public.mcp_register_client(client_name text, redirect_uris text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  nuevo public.mcp_oauth_clients;
  uri text;
begin
  if client_name is null or pg_catalog.btrim(client_name) = '' then return null; end if;
  if redirect_uris is null then return null; end if;

  if pg_catalog.array_length(redirect_uris, 1) is null
     or pg_catalog.array_length(redirect_uris, 1) > 10 then
    return null;
  end if;

  foreach uri in array redirect_uris loop
    if uri is null or pg_catalog.length(uri) > 2000 then return null; end if;
    if pg_catalog.strpos(uri, '#') > 0 then return null; end if;
    if not (
      uri like 'https://%'
      or uri like 'http://localhost:%' or uri like 'http://localhost/%' or uri = 'http://localhost'
      or uri like 'http://127.0.0.1:%' or uri like 'http://127.0.0.1/%' or uri = 'http://127.0.0.1'
    ) then
      return null;
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from public.mcp_oauth_clients c
    where c.created_at > pg_catalog.now() - interval '1 hour'
  ) >= 20 then
    return null;
  end if;

  insert into public.mcp_oauth_clients (client_name, redirect_uris)
  values (pg_catalog.left(client_name, 200), redirect_uris)
  returning * into nuevo;

  return pg_catalog.jsonb_build_object(
    'client_id', nuevo.client_id,
    'client_id_issued_at', (extract(epoch from nuevo.created_at))::bigint,
    'client_name', nuevo.client_name,
    'redirect_uris', pg_catalog.to_jsonb(nuevo.redirect_uris)
  );
end;
$$;

revoke all on function public.mcp_register_client(text, text[]) from public;
grant execute on function public.mcp_register_client(text, text[]) to anon;

-- --------------------------------------------------------------------------
-- Autorizacion: la concede Ruben desde la aplicacion
-- --------------------------------------------------------------------------

-- Lo que la pantalla de autorizacion necesita saber del cliente para poder
-- enseñarlo: como se llama. Devuelve null si el client_id no existe o si la
-- redireccion que pide no es una de las suyas, y en ese caso la pantalla no
-- redirige a ninguna parte: enseña el error. Esa es la defensa contra que
-- alguien mande a Ruben un enlace de autorizacion con una redireccion suya.
create function public.mcp_client_for_authorization(client_id uuid, redirect_uri text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('client_name', c.client_name)
  from public.mcp_oauth_clients c
  where c.client_id = mcp_client_for_authorization.client_id
    and mcp_client_for_authorization.redirect_uri = any (c.redirect_uris)
$$;

revoke all on function public.mcp_client_for_authorization(uuid, text) from public;
grant execute on function public.mcp_client_for_authorization(uuid, text) to authenticated;

-- El alta del codigo de autorizacion. La llama el navegador de Ruben con su
-- propia sesion, asi que auth.uid() es quien autoriza y no hace falta ninguna
-- credencial de servidor.
--
-- El codigo en claro lo genera el navegador y no sale de ahi mas que en la
-- redireccion: aqui solo entra su SHA-256. La funcion es security definer
-- porque escribe en una tabla sin politicas, pero comprueba por su cuenta las
-- dos cosas que importan: que el proyecto es de quien llama, y que la
-- redireccion esta registrada para ese cliente.
create function public.mcp_issue_authorization_code(
  client_id uuid,
  project_id uuid,
  redirect_uri text,
  code_challenge text,
  resource text,
  code_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  quien uuid := auth.uid();
begin
  if quien is null then return false; end if;

  -- PKCE S256: el reto son 32 bytes en base64url, 43 caracteres.
  if code_challenge is null or code_challenge !~ '^[A-Za-z0-9_-]{43}$' then return false; end if;
  if code_hash is null or code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  if resource is null or pg_catalog.btrim(resource) = '' then return false; end if;

  if not exists (
    select 1 from public.roadmap_projects p
    where p.id = mcp_issue_authorization_code.project_id
      and p.owner_id = quien
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.mcp_oauth_clients c
    where c.client_id = mcp_issue_authorization_code.client_id
      and mcp_issue_authorization_code.redirect_uri = any (c.redirect_uris)
  ) then
    return false;
  end if;

  -- Un codigo caducado no sirve para nada y no hay proceso que barra la tabla,
  -- asi que se barre aqui, que es el unico sitio por donde crece.
  delete from public.mcp_oauth_codes c
  where c.expires_at < pg_catalog.now() - interval '1 day';

  insert into public.mcp_oauth_codes
    (code_hash, client_id, project_id, owner_id, redirect_uri, code_challenge, resource, expires_at)
  values
    (code_hash, client_id, project_id, quien, redirect_uri, code_challenge, resource,
     pg_catalog.now() + interval '5 minutes');

  return true;
end;
$$;

revoke all on function public.mcp_issue_authorization_code(uuid, uuid, text, text, text, text) from public;
grant execute on function public.mcp_issue_authorization_code(uuid, uuid, text, text, text, text) to authenticated;

-- --------------------------------------------------------------------------
-- Canje y renovacion de tokens
-- --------------------------------------------------------------------------

-- Canje del codigo por tokens.
--
-- La comprobacion de PKCE se hace aqui, no en el endpoint, porque esta funcion
-- es publica para anon: si el endpoint comparase el reto y la base se fiara,
-- cualquiera con el codigo podria saltarse PKCE llamando directamente a la RPC.
--
-- El consumo del codigo es un unico update con todas las condiciones en el
-- where, de modo que dos canjes simultaneos del mismo codigo no pueden ganar
-- los dos.
--
-- Si el codigo ya estaba consumido, se revoca lo que se emitio con el: un
-- codigo presentado dos veces significa que alguien mas lo tiene.
create function public.mcp_exchange_authorization_code(
  code text,
  client_id uuid,
  redirect_uri text,
  code_verifier text,
  access_token_hash text,
  refresh_token_hash text,
  access_ttl_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  hash_codigo text;
  reto text;
  fila public.mcp_oauth_codes;
begin
  if code is null or code_verifier is null then return null; end if;
  if access_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  if refresh_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  if access_ttl_seconds is null or access_ttl_seconds < 60 or access_ttl_seconds > 86400 then
    return null;
  end if;

  -- RFC 7636: el verificador son entre 43 y 128 caracteres del alfabeto unreserved.
  if code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then return null; end if;

  hash_codigo := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(code, 'UTF8')), 'hex');

  reto := pg_catalog.rtrim(
    pg_catalog.translate(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(code_verifier, 'UTF8')), 'base64'),
      '+/', '-_'),
    '=');

  update public.mcp_oauth_codes c
  set consumed_at = pg_catalog.now()
  where c.code_hash = hash_codigo
    and c.consumed_at is null
    and c.expires_at > pg_catalog.now()
    and c.client_id = mcp_exchange_authorization_code.client_id
    and c.redirect_uri = mcp_exchange_authorization_code.redirect_uri
    and c.code_challenge = reto
  returning c.* into fila;

  if fila.code_hash is null then
    update public.mcp_oauth_tokens t
    set revoked_at = pg_catalog.now()
    where t.code_hash = hash_codigo
      and t.revoked_at is null;
    return null;
  end if;

  insert into public.mcp_oauth_tokens
    (chain_id, code_hash, client_id, project_id, owner_id, resource,
     access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
  values
    (pg_catalog.gen_random_uuid(), fila.code_hash, fila.client_id, fila.project_id,
     fila.owner_id, fila.resource, access_token_hash, refresh_token_hash,
     pg_catalog.now() + pg_catalog.make_interval(secs => access_ttl_seconds),
     pg_catalog.now() + interval '90 days');

  return pg_catalog.jsonb_build_object(
    'expires_in', access_ttl_seconds,
    'resource', fila.resource
  );
end;
$$;

revoke all on function public.mcp_exchange_authorization_code(text, uuid, text, text, text, text, integer) from public;
grant execute on function public.mcp_exchange_authorization_code(text, uuid, text, text, text, text, integer) to anon;

-- Renovacion con rotacion del refresh token, que es lo que la especificacion
-- exige para clientes publicos.
--
-- Presentar un refresh token ya rotado no es un descuido del cliente: es la
-- señal de que ese token lo tiene alguien mas. Se revoca la cadena entera y se
-- devuelve null, que el endpoint traduce a invalid_grant.
create function public.mcp_refresh_access_token(
  refresh_token text,
  client_id uuid,
  access_token_hash text,
  refresh_token_hash text,
  access_ttl_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  viejo public.mcp_oauth_tokens;
begin
  if refresh_token is null then return null; end if;
  if access_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  if refresh_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  if access_ttl_seconds is null or access_ttl_seconds < 60 or access_ttl_seconds > 86400 then
    return null;
  end if;

  select t.* into viejo
  from public.mcp_oauth_tokens t
  where t.refresh_token_hash = pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(refresh_token, 'UTF8')), 'hex')
    and t.client_id = mcp_refresh_access_token.client_id;

  if viejo.id is null then return null; end if;

  if viejo.rotated_at is not null then
    update public.mcp_oauth_tokens t
    set revoked_at = pg_catalog.now()
    where t.chain_id = viejo.chain_id
      and t.revoked_at is null;
    return null;
  end if;

  if viejo.revoked_at is not null then return null; end if;
  if viejo.refresh_expires_at <= pg_catalog.now() then return null; end if;

  update public.mcp_oauth_tokens t
  set rotated_at = pg_catalog.now(),
      revoked_at = pg_catalog.now()
  where t.id = viejo.id
    and t.rotated_at is null;

  if not found then return null; end if;

  insert into public.mcp_oauth_tokens
    (chain_id, code_hash, client_id, project_id, owner_id, resource,
     access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
  values
    (viejo.chain_id, viejo.code_hash, viejo.client_id, viejo.project_id,
     viejo.owner_id, viejo.resource, access_token_hash, refresh_token_hash,
     pg_catalog.now() + pg_catalog.make_interval(secs => access_ttl_seconds),
     viejo.refresh_expires_at);

  return pg_catalog.jsonb_build_object(
    'expires_in', access_ttl_seconds,
    'resource', viejo.resource
  );
end;
$$;

revoke all on function public.mcp_refresh_access_token(text, uuid, text, text, integer) from public;
grant execute on function public.mcp_refresh_access_token(text, uuid, text, text, integer) to anon;

-- --------------------------------------------------------------------------
-- La unica puerta de lectura del servidor MCP
-- --------------------------------------------------------------------------

-- Gemela de roadmap_document_by_key, con la misma forma y el mismo alcance:
-- exactamente una columna de una fila, el documento del proyecto al que apunta
-- el token. Ni owner_id, ni slug, ni el uuid de la fila, ni las fechas.
--
-- Devuelve null cuando el token no existe, esta revocado, ha caducado o su
-- proyecto ya no esta. Quien llama no puede distinguir los cuatro casos, ni
-- saber si algun proyecto existe.
create function public.mcp_document_by_access_token(access_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select p.document
  from public.mcp_oauth_tokens t
  join public.roadmap_projects p on p.id = t.project_id
  where t.revoked_at is null
    and t.access_expires_at > pg_catalog.now()
    and t.access_token_hash = pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(access_token, 'UTF8')), 'hex')
  limit 1;
$$;

revoke all on function public.mcp_document_by_access_token(text) from public;
grant execute on function public.mcp_document_by_access_token(text) to anon;
