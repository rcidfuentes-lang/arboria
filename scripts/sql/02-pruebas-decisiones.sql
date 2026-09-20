-- Ejercita el decisor contra un Postgres de verdad.
--
-- Lo mismo que 01-pruebas-oauth.sql hace con el conector: comprobar que el SQL
-- dice lo que se cree que dice. Cada bloque cambia de rol y de usuario como
-- llegan las llamadas de PostgREST, porque lo que se prueba es sobre todo
-- quien puede que.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados_d (n serial, prueba text, ok boolean, detalle text);
grant all on resultados_d to public;
grant all on sequence resultados_d_n_seq to public;

create or replace function pg_temp.anotar_d(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados_d (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.comoAnon_d() returns void language sql as $$
  select set_config('role','anon',true), set_config('request.jwt.claim.sub','',true);
$$;

create or replace function pg_temp.comoUsuario_d(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

-- El reto de PKCE, que hace falta para emitir un token del conector y
-- comprobar que tambien abre las decisiones. Se define otra vez aqui porque
-- cada fichero corre en su propia sesion de psql y lo temporal no sobrevive.
create or replace function pg_temp.reto(v text) returns text language sql as $$
  select rtrim(translate(encode(sha256(convert_to(v,'UTF8')),'base64'),'+/','-_'),'=')
$$;

-- Devuelve true si la sentencia falla, que es lo que se quiere comprobar en
-- todo lo que la base tiene que rechazar.
create or replace function pg_temp.falla(sentencia text) returns boolean
language plpgsql as $$
begin
  execute sentencia;
  return false;
exception when others then
  return true;
end;
$$;

do $prueba$
declare
  ruben uuid := gen_random_uuid();
  otro  uuid := gen_random_uuid();
  songplay uuid;
  segundo uuid;
  ajeno uuid;
  d1 uuid;
  d2 uuid;
  dA uuid;
  documento jsonb;
  fila jsonb;
  cuantas integer;
  cliente uuid;
  verificador text := 'un-verificador-de-pkce-largo-y-valido-1234567890';
  codigo text := 'codigo-para-el-decisor';
  acceso text := 'token-de-acceso-del-decisor';
  renueva text := 'token-de-renovacion-del-decisor';
begin
  ---------------------------------------------------------------- el montaje
  insert into auth.users (id) values (ruben), (otro);

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Songplay', 'songplay',
    '{"schemaVersion":1,"project":{"id":"songplay","name":"Songplay"},"ideas":[],"nodes":[{"id":"SP","title":"Raiz","status":"planned","content":"","children":[]}]}'::jsonb)
  returning id into songplay;

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Otro proyecto de Ruben', 'otro',
    '{"schemaVersion":1,"project":{"id":"otro","name":"Otro"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into segundo;

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (otro, 'De otra persona', 'ajeno',
    '{"schemaVersion":1,"project":{"id":"ajeno","name":"Ajeno"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into ajeno;

  ------------------------------------------------------------ escribir: quien
  perform pg_temp.comoUsuario_d(ruben);

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (songplay, 'El decisor va en tabla propia, no dentro del document.',
          date '2026-09-20', 'La respuesta de /api/roadmap es byte a byte la exportacion.',
          'arquitectura')
  returning id into d1;
  perform pg_temp.anotar_d('el dueño escribe una decision en su proyecto', d1 is not null);

  perform pg_temp.anotar_d('la numeracion empieza en 1',
    (select numero from public.decisiones where id = d1) = 1);

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema, detalle, nodo_id)
  values (songplay, 'Las decisiones no se borran.', date '2026-09-20',
          'Una decision retirada sigue explicando por que se hizo lo que se hizo.',
          'proceso', 'acta del 20 de septiembre', 'SP')
  returning id into d2;
  perform pg_temp.anotar_d('la numeracion sigue en 2',
    (select numero from public.decisiones where id = d2) = 2);

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (segundo, 'Una decision del otro proyecto.', date '2026-09-20', 'Porque si.', 'varios')
  returning id into dA;
  perform pg_temp.anotar_d('cada proyecto numera por su cuenta',
    (select numero from public.decisiones where id = dA) = 1);

  perform pg_temp.anotar_d('no se puede escribir en el proyecto de otro',
    pg_temp.falla(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
       values (%L, %L, current_date, %L, %L)', ajeno, 'No deberia entrar', 'motivo', 'tema')));

  perform pg_temp.comoUsuario_d(otro);
  perform pg_temp.anotar_d('otro usuario no ve las decisiones de Ruben',
    (select count(*) from public.decisiones) = 0);

  -- A anon no se le niegan las filas: se le niega la tabla. La RLS ya lo
  -- dejaria sin ninguna, pero ademas se le retiraron los privilegios, asi que
  -- ni siquiera puede preguntar.
  perform pg_temp.comoAnon_d();
  perform pg_temp.anotar_d('anon no puede ni preguntar por las decisiones',
    pg_temp.falla('select count(*) from public.decisiones'));

  ------------------------------------------------------------ lo que se exige
  perform pg_temp.comoUsuario_d(ruben);

  perform pg_temp.anotar_d('una decision sin texto no entra',
    pg_temp.falla(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
       values (%L, %L, current_date, %L, %L)', songplay, '   ', 'motivo', 'tema')));

  perform pg_temp.anotar_d('una decision sin motivo no entra',
    pg_temp.falla(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
       values (%L, %L, current_date, %L, %L)', songplay, 'algo', '', 'tema')));

  perform pg_temp.anotar_d('un estado inventado no entra',
    pg_temp.falla(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema, estado)
       values (%L, %L, current_date, %L, %L, %L)', songplay, 'algo', 'motivo', 'tema', 'dudosa')));

  perform pg_temp.anotar_d('activa con motivo de inactivacion no entra',
    pg_temp.falla(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema, motivo_inactivacion)
       values (%L, %L, current_date, %L, %L, %L)', songplay, 'algo', 'motivo', 'tema', 'sobra')));

  perform pg_temp.anotar_d('inactivar sin decir por que no se puede',
    pg_temp.falla(format(
      'update public.decisiones set estado = %L, sustituida_por = %L where id = %L',
      'inactiva', d2, d1)));

  perform pg_temp.anotar_d('inactivar sin sustituta no se puede',
    pg_temp.falla(format(
      'update public.decisiones set estado = %L, motivo_inactivacion = %L where id = %L',
      'inactiva', 'ya no vale', d1)));

  perform pg_temp.anotar_d('una decision no se sustituye a si misma',
    pg_temp.falla(format(
      'update public.decisiones set estado = %L, motivo_inactivacion = %L, sustituida_por = %L where id = %L',
      'inactiva', 'ya no vale', d1, d1)));

  perform pg_temp.anotar_d('la sustituta no puede ser de otro proyecto',
    pg_temp.falla(format(
      'update public.decisiones set estado = %L, motivo_inactivacion = %L, sustituida_por = %L where id = %L',
      'inactiva', 'ya no vale', dA, d1)));

  perform pg_temp.anotar_d('la sustituta tiene que existir',
    pg_temp.falla(format(
      'update public.decisiones set estado = %L, motivo_inactivacion = %L, sustituida_por = %L where id = %L',
      'inactiva', 'ya no vale', gen_random_uuid(), d1)));

  ------------------------------------------------------------ inactivar bien
  update public.decisiones
  set estado = 'inactiva',
      motivo_inactivacion = 'La 2 dice lo mismo y mejor.',
      sustituida_por = d2
  where id = d1;
  perform pg_temp.anotar_d('inactivar con motivo y sustituta si se puede',
    (select estado from public.decisiones where id = d1) = 'inactiva');

  ------------------------------------------------------------------ el rastro
  update public.decisiones
  set decidido = 'El decisor va en tabla propia. Corregido.'
  where id = d2;

  select count(*) into cuantas
  from public.decisiones_historial where decision_id = d2 and campo = 'decidido';
  perform pg_temp.anotar_d('corregir el texto deja rastro', cuantas = 1);

  perform pg_temp.anotar_d('el rastro guarda lo que decia antes',
    (select antes from public.decisiones_historial
     where decision_id = d2 and campo = 'decidido') = 'Las decisiones no se borran.');

  perform pg_temp.anotar_d('inactivar tambien deja rastro',
    (select count(*) from public.decisiones_historial where decision_id = d1) = 3,
    'estado, motivo_inactivacion y sustituida_por');

  perform pg_temp.anotar_d('updated_at se mueve solo',
    (select updated_at > created_at from public.decisiones where id = d2));

  perform pg_temp.anotar_d('el rastro no se puede escribir a mano',
    pg_temp.falla(format(
      'insert into public.decisiones_historial (decision_id, campo, antes, despues)
       values (%L, %L, %L, %L)', d2, 'decidido', 'inventado', 'inventado')));

  perform pg_temp.anotar_d('el rastro no se puede retocar',
    pg_temp.falla(format(
      'update public.decisiones_historial set antes = %L where decision_id = %L', 'otra cosa', d2)));

  perform pg_temp.anotar_d('el rastro si se lee',
    (select count(*) from public.decisiones_historial) >= 4);

  ------------------------------------------------------------------- no borrar
  perform pg_temp.anotar_d('una decision no se borra',
    pg_temp.falla(format('delete from public.decisiones where id = %L', d2)));

  ------------------------------------------------------ la puerta de la API
  perform set_config('role','postgres',true);
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  values (songplay, encode(sha256(convert_to('clave-songplay','UTF8')),'hex'), 'Songplay'),
         (segundo,  encode(sha256(convert_to('clave-segundo','UTF8')),'hex'), 'Segundo'),
         (songplay, encode(sha256(convert_to('clave-revocada','UTF8')),'hex'), 'Revocada');
  update public.roadmap_api_keys set revoked_at = now()
  where key_hash = encode(sha256(convert_to('clave-revocada','UTF8')),'hex');

  perform pg_temp.comoAnon_d();

  documento := public.decisiones_by_key('clave-songplay');
  perform pg_temp.anotar_d('la clave abre las decisiones de su proyecto',
    jsonb_array_length(documento->'decisiones') = 2);
  perform pg_temp.anotar_d('y trae el proyecto que le corresponde',
    documento->'project'->>'id' = 'songplay');

  fila := documento->'decisiones'->0;
  perform pg_temp.anotar_d('la primera decision es la numero 1', (fila->>'numero')::int = 1);
  perform pg_temp.anotar_d('la inactiva dice quien la sustituye, por numero',
    (fila->'inactivacion'->>'sustituida_por')::int = 2);
  perform pg_temp.anotar_d('la inactiva dice por que se quito',
    fila->'inactivacion'->>'motivo' = 'La 2 dice lo mismo y mejor.');
  perform pg_temp.anotar_d('la activa no lleva inactivacion',
    documento->'decisiones'->1->'inactivacion' = 'null'::jsonb);
  perform pg_temp.anotar_d('la corregida lleva su rastro',
    jsonb_array_length(documento->'decisiones'->1->'correcciones') = 1);
  perform pg_temp.anotar_d('la decision que se toco lleva corregida_el',
    documento->'decisiones'->0->>'corregida_el' is not null,
    'la 1 se inactivo, asi que si tiene');

  perform pg_temp.anotar_d('la clave de un proyecto no abre las del otro',
    jsonb_array_length(public.decisiones_by_key('clave-segundo')->'decisiones') = 1);
  perform pg_temp.anotar_d('una clave revocada no abre nada',
    public.decisiones_by_key('clave-revocada') is null);
  perform pg_temp.anotar_d('una clave inventada no abre nada',
    public.decisiones_by_key('clave-que-no-existe') is null);

  perform pg_temp.anotar_d('un proyecto sin decisiones devuelve lista vacia, no null',
    public.decisiones_by_key('clave-segundo') is not null);

  ---------------------------------------------------- la puerta del conector
  perform set_config('role','postgres',true);
  insert into public.mcp_oauth_clients (client_name, redirect_uris)
  values ('Cliente de prueba', array['https://claude.ai/api/mcp/auth_callback'])
  returning client_id into cliente;

  perform pg_temp.comoUsuario_d(ruben);
  perform public.mcp_issue_authorization_code(cliente, songplay,
    'https://claude.ai/api/mcp/auth_callback', pg_temp.reto(verificador),
    'https://arboria.rubenstuff.es/mcp', encode(sha256(convert_to(codigo,'UTF8')),'hex'));

  perform pg_temp.comoAnon_d();
  perform public.mcp_exchange_authorization_code(codigo, cliente,
    'https://claude.ai/api/mcp/auth_callback', verificador,
    encode(sha256(convert_to(acceso,'UTF8')),'hex'),
    encode(sha256(convert_to(renueva,'UTF8')),'hex'), 3600);

  perform pg_temp.anotar_d('el token del conector abre las decisiones',
    jsonb_array_length(public.mcp_decisiones_by_access_token(acceso)->'decisiones') = 2);
  perform pg_temp.anotar_d('y son las del proyecto al que esta atado',
    public.mcp_decisiones_by_access_token(acceso)->'project'->>'id' = 'songplay');
  perform pg_temp.anotar_d('un token inventado no abre nada',
    public.mcp_decisiones_by_access_token('token-que-no-existe') is null);
  perform pg_temp.anotar_d('una clave de lectura no vale como token',
    public.mcp_decisiones_by_access_token('clave-songplay') is null);
  perform pg_temp.anotar_d('un token no vale como clave de lectura',
    public.decisiones_by_key(acceso) is null);

  perform set_config('role','postgres',true);
  update public.mcp_oauth_tokens set access_expires_at = now() - interval '1 minute'
  where access_token_hash = encode(sha256(convert_to(acceso,'UTF8')),'hex');
  perform pg_temp.comoAnon_d();
  perform pg_temp.anotar_d('un token caducado no abre nada',
    public.mcp_decisiones_by_access_token(acceso) is null);

  ------------------------------------------------- el armado no es de nadie
  perform pg_temp.anotar_d('anon no puede llamar al armado del documento',
    pg_temp.falla(format('select public.decisiones_de_proyecto(%L)', songplay)));
  perform pg_temp.comoUsuario_d(ruben);
  perform pg_temp.anotar_d('un usuario con sesion tampoco',
    pg_temp.falla(format('select public.decisiones_de_proyecto(%L)', songplay)));

  ------------------------------------------- borrar el proyecto se las lleva
  perform set_config('role','postgres',true);
  delete from public.roadmap_projects where id = songplay;
  perform pg_temp.anotar_d('borrar el proyecto se lleva sus decisiones',
    (select count(*) from public.decisiones where project_id = songplay) = 0);
  perform pg_temp.anotar_d('y su rastro',
    (select count(*) from public.decisiones_historial where decision_id in (d1, d2)) = 0);

  -------------------------------------------------- lo de antes sigue igual
  perform pg_temp.comoAnon_d();
  perform pg_temp.anotar_d('roadmap_document_by_key sigue funcionando',
    public.roadmap_document_by_key('clave-segundo') is not null);

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados_d order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados_d;
