-- Ejercita las funciones OAuth del conector MCP contra un Postgres de verdad.
--
-- Esto comprueba lo que la simulacion en JavaScript de scripts/verificar-mcp.mjs
-- no puede comprobar: que el SQL dice lo que se cree que dice. Cada bloque
-- cambia de rol con set_config('role', ...) y de usuario con el claim que lee
-- auth.uid(), que es como llegan las llamadas de PostgREST.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados (n serial, prueba text, ok boolean, detalle text);
grant all on resultados to public;
grant all on sequence resultados_n_seq to public;

create or replace function pg_temp.anotar(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.reto(v text) returns text language sql as $$
  select rtrim(translate(encode(sha256(convert_to(v,'UTF8')),'base64'),'+/','-_'),'=')
$$;

create or replace function pg_temp.comoAnon() returns void language sql as $$
  select set_config('role','anon',true), set_config('request.jwt.claim.sub','',true);
$$;

create or replace function pg_temp.comoUsuario(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

do $prueba$
declare
  ruben uuid := gen_random_uuid();
  otro  uuid := gen_random_uuid();
  songplay uuid;
  segundo uuid;
  cliente uuid;
  alta jsonb;
  verificador text := 'un-verificador-de-pkce-largo-y-valido-1234567890';
  codigo text := 'codigo-de-autorizacion-de-prueba';
  acceso text := 'token-de-acceso-de-prueba';
  renueva text := 'token-de-renovacion-de-prueba';
  acceso2 text := 'segundo-token-de-acceso';
  renueva2 text := 'segundo-token-de-renovacion';
  acceso3 text := 'tercer-token-de-acceso';
  renueva3 text := 'tercer-token-de-renovacion';
  emitido jsonb;
  documento jsonb;
  ok boolean;
begin
  insert into auth.users (id) values (ruben), (otro);
  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Songplay', 'songplay',
          '{"schemaVersion":1,"project":{"id":"songplay","name":"Songplay"},"ideas":[],"nodes":[{"id":"SP","title":"Songplay","status":"planned","content":"","children":[]}]}'::jsonb)
  returning id into songplay;
  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Otro', 'otro',
          '{"schemaVersion":1,"project":{"id":"otro","name":"Otro"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into segundo;

  ---------------------------------------------------------------- registro
  perform pg_temp.comoAnon();
  alta := public.mcp_register_client('Claude', array['https://claude.ai/api/mcp/auth_callback']);
  cliente := (alta->>'client_id')::uuid;
  perform pg_temp.anotar('anon puede registrar un cliente', cliente is not null, coalesce(cliente::text,'null'));

  perform pg_temp.anotar('redireccion http que no es localhost: rechazada',
    public.mcp_register_client('Malo', array['http://ejemplo.invalido/x']) is null);
  perform pg_temp.anotar('redireccion con fragmento: rechazada',
    public.mcp_register_client('Malo', array['https://ejemplo.invalido/x#y']) is null);
  perform pg_temp.anotar('localhost si se admite, para poder probar',
    public.mcp_register_client('Inspector', array['http://localhost:6274/oauth/callback']) is not null);

  begin
    perform 1 from public.mcp_oauth_clients;
    perform pg_temp.anotar('anon no puede leer la tabla de clientes', false, 'la ha leido');
  exception when insufficient_privilege then
    perform pg_temp.anotar('anon no puede leer la tabla de clientes', true, 'permiso denegado');
  end;

  begin
    perform public.mcp_issue_authorization_code(cliente, songplay,
      'https://claude.ai/api/mcp/auth_callback', pg_temp.reto(verificador),
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex'));
    perform pg_temp.anotar('anon no puede emitir codigos de autorizacion', false, 'lo ha emitido');
  exception when insufficient_privilege then
    perform pg_temp.anotar('anon no puede emitir codigos de autorizacion', true, 'permiso denegado');
  end;

  ------------------------------------------------------------ autorizacion
  perform pg_temp.comoUsuario(otro);
  perform pg_temp.anotar('otro usuario no puede conceder un proyecto ajeno',
    public.mcp_issue_authorization_code(cliente, songplay,
      'https://claude.ai/api/mcp/auth_callback', pg_temp.reto(verificador),
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex')) = false);

  perform pg_temp.comoUsuario(ruben);
  perform pg_temp.anotar('redireccion no registrada: no se concede',
    public.mcp_issue_authorization_code(cliente, songplay,
      'https://sitio.invalido/vuelta', pg_temp.reto(verificador),
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex')) = false);

  perform pg_temp.anotar('reto PKCE con mala forma: no se concede',
    public.mcp_issue_authorization_code(cliente, songplay,
      'https://claude.ai/api/mcp/auth_callback', 'corto',
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex')) = false);

  perform pg_temp.anotar('el dueño ve el nombre del cliente',
    public.mcp_client_for_authorization(cliente, 'https://claude.ai/api/mcp/auth_callback')->>'client_name' = 'Claude');
  perform pg_temp.anotar('con otra redireccion no ve nada',
    public.mcp_client_for_authorization(cliente, 'https://sitio.invalido/x') is null);

  begin
    documento := public.mcp_document_by_access_token('lo-que-sea');
    perform pg_temp.anotar('authenticated no puede leer por token de acceso', false, 'ha podido');
  exception when insufficient_privilege then
    perform pg_temp.anotar('authenticated no puede leer por token de acceso', true, 'permiso denegado');
  end;

  perform pg_temp.anotar('el dueño concede su proyecto',
    public.mcp_issue_authorization_code(cliente, songplay,
      'https://claude.ai/api/mcp/auth_callback', pg_temp.reto(verificador),
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex')) = true);

  ------------------------------------------------------------------ canje
  perform pg_temp.comoAnon();
  perform pg_temp.anotar('verificador PKCE equivocado: no hay token',
    public.mcp_exchange_authorization_code(codigo, cliente,
      'https://claude.ai/api/mcp/auth_callback', 'otro-verificador-completamente-distinto-1234',
      encode(sha256(convert_to(acceso,'UTF8')),'hex'),
      encode(sha256(convert_to(renueva,'UTF8')),'hex'), 3600) is null);

  perform pg_temp.anotar('otra redireccion en el canje: no hay token',
    public.mcp_exchange_authorization_code(codigo, cliente,
      'https://claude.com/api/mcp/auth_callback', verificador,
      encode(sha256(convert_to(acceso,'UTF8')),'hex'),
      encode(sha256(convert_to(renueva,'UTF8')),'hex'), 3600) is null);

  emitido := public.mcp_exchange_authorization_code(codigo, cliente,
      'https://claude.ai/api/mcp/auth_callback', verificador,
      encode(sha256(convert_to(acceso,'UTF8')),'hex'),
      encode(sha256(convert_to(renueva,'UTF8')),'hex'), 3600);
  perform pg_temp.anotar('canje correcto', emitido is not null, coalesce(emitido::text,'null'));

  documento := public.mcp_document_by_access_token(acceso);
  perform pg_temp.anotar('el token lee su proyecto', documento->'project'->>'id' = 'songplay',
    coalesce(documento->'project'->>'id','null'));
  perform pg_temp.anotar('y no trae nada de la fila', documento ? 'owner_id' = false);

  perform pg_temp.anotar('un token inventado no lee nada',
    public.mcp_document_by_access_token('inventado') is null);

  ---------------------------------------------------------------- reenvio
  perform pg_temp.anotar('el mismo codigo por segunda vez: no hay token',
    public.mcp_exchange_authorization_code(codigo, cliente,
      'https://claude.ai/api/mcp/auth_callback', verificador,
      encode(sha256(convert_to('otro','UTF8')),'hex'),
      encode(sha256(convert_to('otro2','UTF8')),'hex'), 3600) is null);
  perform pg_temp.anotar('y eso revoca el token que salio de el',
    public.mcp_document_by_access_token(acceso) is null);

  -------------------------------------------------------------- renovacion
  perform pg_temp.comoUsuario(ruben);
  codigo := 'segundo-codigo-de-autorizacion';
  perform public.mcp_issue_authorization_code(cliente, songplay,
      'https://claude.ai/api/mcp/auth_callback', pg_temp.reto(verificador),
      'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex'));
  perform pg_temp.comoAnon();
  perform public.mcp_exchange_authorization_code(codigo, cliente,
      'https://claude.ai/api/mcp/auth_callback', verificador,
      encode(sha256(convert_to(acceso3,'UTF8')),'hex'),
      encode(sha256(convert_to(renueva3,'UTF8')),'hex'), 3600);

  emitido := public.mcp_refresh_access_token(renueva3, cliente,
      encode(sha256(convert_to(acceso2,'UTF8')),'hex'),
      encode(sha256(convert_to(renueva2,'UTF8')),'hex'), 3600);
  perform pg_temp.anotar('el refresh token renueva', emitido is not null);
  perform pg_temp.anotar('el token nuevo lee', public.mcp_document_by_access_token(acceso2) is not null);
  perform pg_temp.anotar('el token viejo ya no lee', public.mcp_document_by_access_token(acceso3) is null);

  perform pg_temp.anotar('reutilizar el refresh ya rotado: no renueva',
    public.mcp_refresh_access_token(renueva3, cliente,
      encode(sha256(convert_to('x','UTF8')),'hex'),
      encode(sha256(convert_to('y','UTF8')),'hex'), 3600) is null);
  perform pg_temp.anotar('y revoca la cadena entera',
    public.mcp_document_by_access_token(acceso2) is null);

  ------------------------------------------------------ la API de siempre
  perform pg_temp.comoAnon();
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  select songplay, encode(sha256(convert_to('clave-de-lectura','UTF8')),'hex'), 'Prueba'
  where false;
  perform set_config('role','postgres',true);
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  values (songplay, encode(sha256(convert_to('clave-de-lectura','UTF8')),'hex'), 'Prueba');
  perform pg_temp.comoAnon();
  perform pg_temp.anotar('roadmap_document_by_key sigue funcionando',
    public.roadmap_document_by_key('clave-de-lectura')->'project'->>'id' = 'songplay');
  perform pg_temp.anotar('una clave de lectura no vale como token de acceso',
    public.mcp_document_by_access_token('clave-de-lectura') is null);

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados;
