-- Ejercita el importador de decisiones contra un Postgres de verdad.
--
-- Lo que mas importa aqui es lo que no se ve cuando sale bien: que un fichero
-- con un fallo no deja nada escrito, y que volver a importar el mismo fichero
-- no duplica ni "corrige" nada.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados_i (n serial, prueba text, ok boolean, detalle text);
grant all on resultados_i to public;
grant all on sequence resultados_i_n_seq to public;

create or replace function pg_temp.anotar_i(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados_i (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.comoAnon_i() returns void language sql as $$
  select set_config('role','anon',true), set_config('request.jwt.claim.sub','',true);
$$;

create or replace function pg_temp.comoUsuario_i(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

create or replace function pg_temp.falla_i(sentencia text) returns boolean
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
  otro uuid := gen_random_uuid();
  songplay uuid;
  ajeno uuid;
  resumen jsonb;
  fichero jsonb;
  cuantas integer;
  sello timestamptz;
  rastros integer;
begin
  insert into auth.users (id) values (ruben), (otro);

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Songplay', 'songplay',
    '{"schemaVersion":1,"project":{"id":"songplay","name":"Songplay"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into songplay;

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (otro, 'De otra persona', 'ajeno',
    '{"schemaVersion":1,"project":{"id":"ajeno","name":"Ajeno"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into ajeno;

  ------------------------------------------------------- un fichero correcto
  fichero := $json$[
    {
      "ref": "tabla-propia",
      "decidido": "El decisor va en tabla propia.",
      "fecha": "2026-09-20",
      "motivo": "Los bytes de /api/roadmap no se tocan.",
      "tema": "arquitectura",
      "detalle": "Informe del decisor",
      "nodo": "SP"
    },
    {
      "decidido": "Las decisiones van dentro del documento.",
      "fecha": "2026-09-14",
      "motivo": "Era lo mas barato.",
      "tema": "arquitectura",
      "inactiva": {
        "motivo": "Cambiaria los bytes que consume Songplay.",
        "sustituida_por": "tabla-propia"
      }
    }
  ]$json$::jsonb;

  perform pg_temp.comoUsuario_i(ruben);
  resumen := public.importar_decisiones(songplay, fichero);

  perform pg_temp.anotar_i('un fichero correcto entra entero',
    (resumen->>'escritas')::int = 2 and (resumen->>'inactivadas')::int = 1,
    resumen::text);

  perform pg_temp.anotar_i('numera por orden del fichero',
    (select numero from public.decisiones where project_id = songplay
      and decidido = 'El decisor va en tabla propia.') = 1);

  perform pg_temp.anotar_i('la inactiva queda inactiva, con su motivo',
    (select estado || ' | ' || motivo_inactivacion from public.decisiones
      where project_id = songplay and decidido = 'Las decisiones van dentro del documento.')
      = 'inactiva | Cambiaria los bytes que consume Songplay.');

  perform pg_temp.anotar_i('y senala a la sustituta que venia en el mismo fichero',
    (select s.numero from public.decisiones d
       join public.decisiones s on s.id = d.sustituida_por
      where d.project_id = songplay
        and d.decidido = 'Las decisiones van dentro del documento.') = 1);

  perform pg_temp.anotar_i('los campos opcionales entran, y los que faltan quedan nulos',
    (select detalle = 'Informe del decisor' and nodo_id = 'SP' from public.decisiones
      where project_id = songplay and numero = 1)
    and (select detalle is null and nodo_id is null from public.decisiones
      where project_id = songplay and numero = 2));

  ------------------------------------------- volver a importar el mismo fichero
  select updated_at into sello from public.decisiones where project_id = songplay and numero = 2;
  select count(*) into rastros from public.decisiones_historial h
    join public.decisiones d on d.id = h.decision_id where d.project_id = songplay;

  resumen := public.importar_decisiones(songplay, fichero);
  perform pg_temp.anotar_i('volver a importarlo no escribe nada nuevo',
    (resumen->>'escritas')::int = 0 and (resumen->>'omitidas')::int = 2,
    resumen::text);
  perform pg_temp.anotar_i('y no duplica ninguna',
    (select count(*) from public.decisiones where project_id = songplay) = 2);
  perform pg_temp.anotar_i('ni deja dicho que se corrigieron',
    (select updated_at from public.decisiones where project_id = songplay and numero = 2) = sello
    and (select count(*) from public.decisiones_historial h
          join public.decisiones d on d.id = h.decision_id
         where d.project_id = songplay) = rastros);

  --------------------------------------------- un fichero con un fallo: nada
  select count(*) into cuantas from public.decisiones where project_id = songplay;

  perform pg_temp.anotar_i('una sustituta que no existe tumba el fichero entero',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Esta seria la tercera.", "fecha": "2026-09-21",
       "motivo": "Da igual.", "tema": "proceso"},
      {"decidido": "Y esta la cuarta.", "fecha": "2026-09-21",
       "motivo": "Da igual.", "tema": "proceso",
       "inactiva": {"motivo": "porque si", "sustituida_por": "no-existe-este-ref"}}
    ]$json$)));

  perform pg_temp.anotar_i('y no deja escrita ni la que iba antes del fallo',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas,
    format('habia %s', cuantas));

  perform pg_temp.anotar_i('un numero de sustituta que no existe tambien lo tumba',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Otra mas.", "fecha": "2026-09-22", "motivo": "Da igual.", "tema": "proceso",
       "inactiva": {"motivo": "porque si", "sustituida_por": 99}}
    ]$json$)));

  perform pg_temp.anotar_i('y sigue sin escribirse nada',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_i('lo que la tabla no admite tambien lo tumba entero',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Esta entraria.", "fecha": "2026-09-23", "motivo": "Da igual.", "tema": "proceso"},
      {"decidido": "   ", "fecha": "2026-09-23", "motivo": "Da igual.", "tema": "proceso"}
    ]$json$)));

  perform pg_temp.anotar_i('y tampoco deja la primera',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_i('una fecha imposible no llega a escribirse',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Con fecha rara.", "fecha": "2026-02-31", "motivo": "Da igual.", "tema": "proceso"}
    ]$json$)));

  perform pg_temp.anotar_i('una lista vacia no se importa',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, '[]')));

  ------------------------------------------- sustituir a una que ya estaba
  resumen := public.importar_decisiones(songplay, $json$[
    {"decidido": "La tercera, que sustituye a la primera.", "fecha": "2026-09-24",
     "motivo": "Se afina lo de la tabla propia.", "tema": "arquitectura"}
  ]$json$::jsonb);
  perform pg_temp.anotar_i('entra una suelta', (resumen->>'escritas')::int = 1);

  resumen := public.importar_decisiones(songplay, $json$[
    {"decidido": "La cuarta, y quita la 1 por numero.", "fecha": "2026-09-25",
     "motivo": "Queda dicho mejor.", "tema": "arquitectura"},
    {"decidido": "El decisor va en tabla propia.", "fecha": "2026-09-20",
     "motivo": "Los bytes de /api/roadmap no se tocan.", "tema": "arquitectura",
     "detalle": "Informe del decisor", "nodo": "SP",
     "inactiva": {"motivo": "La 4 lo dice mejor.", "sustituida_por": 4}}
  ]$json$::jsonb);

  perform pg_temp.anotar_i('una entrada que ya estaba se puede inactivar por numero',
    (resumen->>'escritas')::int = 1 and (resumen->>'omitidas')::int = 1
      and (resumen->>'inactivadas')::int = 1,
    resumen::text);

  perform pg_temp.anotar_i('la que ya estaba queda inactiva y apunta a la 4',
    (select s.numero from public.decisiones d
       join public.decisiones s on s.id = d.sustituida_por
      where d.project_id = songplay and d.numero = 1) = 4);

  perform pg_temp.anotar_i('y eso si deja rastro, porque cambio de verdad',
    (select count(*) from public.decisiones_historial h
      join public.decisiones d on d.id = h.decision_id
     where d.project_id = songplay and d.numero = 1) = 3);

  ------------------------------------------------------------ quien puede que
  perform pg_temp.comoUsuario_i(otro);
  perform pg_temp.anotar_i('no se importa en el proyecto de otro',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Metida de tapadillo.", "fecha": "2026-09-26",
       "motivo": "No deberia entrar.", "tema": "proceso"}
    ]$json$)));

  perform pg_temp.comoAnon_i();
  perform pg_temp.anotar_i('anon no puede ni llamar al importador',
    pg_temp.falla_i(format('select public.importar_decisiones(%L, %L::jsonb)', songplay, $json$[
      {"decidido": "Desde fuera.", "fecha": "2026-09-26",
       "motivo": "No deberia entrar.", "tema": "proceso"}
    ]$json$)));

  ---------------------------------------------- y lo importado se lee fuera
  perform set_config('role','postgres',true);
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  values (songplay, encode(sha256(convert_to('clave-import','UTF8')),'hex'), 'Prueba');

  perform pg_temp.comoAnon_i();
  perform pg_temp.anotar_i('la API ve lo importado',
    jsonb_array_length(public.decisiones_by_key('clave-import')->'decisiones') = 4);
  perform pg_temp.anotar_i('con la inactivacion puesta y por numero',
    (public.decisiones_by_key('clave-import')->'decisiones'->0->'inactivacion'->>'sustituida_por')::int = 4);

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados_i order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados_i;
