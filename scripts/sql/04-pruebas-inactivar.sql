-- Ejercita el retirar una decision en un solo acto, contra un Postgres de
-- verdad.
--
-- Lo que se comprueba aqui es sobre todo lo que no se ve cuando sale bien: que
-- si falta el motivo o falta la sustituta no se escribe nada —ni la nueva ni
-- la inactivacion— y que cuando sale bien las dos cosas quedan hechas y
-- enlazadas.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados_r (n serial, prueba text, ok boolean, detalle text);
grant all on resultados_r to public;
grant all on sequence resultados_r_n_seq to public;

create or replace function pg_temp.anotar_r(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados_r (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.comoAnon_r() returns void language sql as $$
  select set_config('role','anon',true), set_config('request.jwt.claim.sub','',true);
$$;

create or replace function pg_temp.comoUsuario_r(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

create or replace function pg_temp.falla_r(sentencia text) returns boolean
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
  d1 uuid;
  d2 uuid;
  d3 uuid;
  dAjena uuid;
  resumen jsonb;
  cuantas integer;
  sello timestamptz;
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

  perform pg_temp.comoUsuario_r(ruben);

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (songplay, 'El decisor va en tabla propia.', '2026-09-20',
          'Los bytes de /api/roadmap no se tocan.', 'arquitectura')
  returning id into d1;

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (songplay, 'Las decisiones no se borran.', '2026-09-20',
          'Un decisor que olvida no sirve.', 'proceso')
  returning id into d2;

  perform pg_temp.comoUsuario_r(otro);
  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (ajeno, 'De otra persona.', '2026-09-20', 'Suya.', 'proceso')
  returning id into dAjena;

  perform pg_temp.comoUsuario_r(ruben);

  ------------------------------------------- retirar escribiendo la sustituta
  resumen := public.inactivar_decision(
    songplay, d1, 'La tabla propia se queda, pero con numeracion por proyecto.',
    null,
    '{"decidido": "El numero de la decision es por proyecto.",
      "fecha": "2026-09-21",
      "motivo": "Decir \"la 7 de Songplay\" tiene que significar algo.",
      "tema": "arquitectura",
      "detalle": "el acta del 21",
      "nodo": "SP1.3"}'::jsonb);

  perform pg_temp.anotar_r('retirar escribiendo la sustituta devuelve los dos numeros',
    (resumen->>'retirada')::int = 1 and (resumen->>'sustituta')::int = 3
      and (resumen->>'creada')::boolean,
    resumen::text);

  perform pg_temp.anotar_r('la nueva queda escrita, activa y con sus campos',
    (select d.estado = 'activa' and d.detalle = 'el acta del 21' and d.nodo_id = 'SP1.3'
       and d.decidido = 'El numero de la decision es por proyecto.'
     from public.decisiones d where d.project_id = songplay and d.numero = 3));

  perform pg_temp.anotar_r('la vieja queda inactiva, con su motivo y apuntando a la nueva',
    (select d.estado = 'inactiva'
       and d.motivo_inactivacion = 'La tabla propia se queda, pero con numeracion por proyecto.'
       and s.numero = 3
     from public.decisiones d
     join public.decisiones s on s.id = d.sustituida_por
     where d.project_id = songplay and d.numero = 1));

  perform pg_temp.anotar_r('y las dos cosas dejan rastro de la vieja',
    (select count(*) from public.decisiones_historial h
      join public.decisiones d on d.id = h.decision_id
     where d.project_id = songplay and d.numero = 1) = 3);

  ------------------------------------------- retirar eligiendo una que existe
  select id into d3 from public.decisiones where project_id = songplay and numero = 3;

  resumen := public.inactivar_decision(
    songplay, d2, 'Lo dice mejor la 3.', d3, null);

  perform pg_temp.anotar_r('retirar eligiendo una que ya existe no crea ninguna',
    (resumen->>'retirada')::int = 2 and (resumen->>'sustituta')::int = 3
      and not (resumen->>'creada')::boolean,
    resumen::text);

  perform pg_temp.anotar_r('y no aparece ninguna decision de mas',
    (select count(*) from public.decisiones where project_id = songplay) = 3);

  ------------------------------------------------------- lo que no se escribe
  select count(*) into cuantas from public.decisiones where project_id = songplay;

  perform pg_temp.anotar_r('sin motivo no se retira',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, null, %L::jsonb)',
      songplay, d3, '   ',
      '{"decidido": "Una que no deberia nacer.", "fecha": "2026-09-22",
        "motivo": "Ninguno.", "tema": "proceso"}')));

  perform pg_temp.anotar_r('y no deja escrita la nueva que iba con ella',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_r('sin sustituta no se retira',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, null, null)',
      songplay, d3, 'Porque si.')));

  perform pg_temp.anotar_r('con las dos sustitutas a la vez tampoco',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, %L::jsonb)',
      songplay, d3, 'Porque si.', d1,
      '{"decidido": "Y ademas esta.", "fecha": "2026-09-22",
        "motivo": "Ninguno.", "tema": "proceso"}')));

  perform pg_temp.anotar_r('una nueva a la que le falta un campo tumba las dos escrituras',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, null, %L::jsonb)',
      songplay, d3, 'Porque si.',
      '{"decidido": "Sin tema.", "fecha": "2026-09-22", "motivo": "Ninguno.", "tema": "  "}')));

  perform pg_temp.anotar_r('una fecha imposible, igual',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, null, %L::jsonb)',
      songplay, d3, 'Porque si.',
      '{"decidido": "Con fecha rara.", "fecha": "2026-13-45", "motivo": "Ninguno.", "tema": "proceso"}')));

  perform pg_temp.anotar_r('nada de eso ha escrito nada',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_r('y la 3 sigue activa',
    (select estado = 'activa' from public.decisiones where project_id = songplay and numero = 3));

  ------------------------------------------------------------ lo que no vale
  perform pg_temp.anotar_r('una decision no se sustituye a si misma',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null)',
      songplay, d3, 'Porque si.', d3)));

  perform pg_temp.anotar_r('una que ya estaba inactiva no se retira otra vez',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null)',
      songplay, d1, 'Otra vez.', d3)));

  perform pg_temp.anotar_r('la sustituta tiene que ser del mismo proyecto',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null)',
      songplay, d3, 'Porque si.', dAjena)));

  select updated_at into sello from public.decisiones where id = d3;
  perform pg_temp.anotar_r('y despues de todo lo que fallo, la 3 ni se ha tocado',
    (select d.updated_at = sello and d.estado = 'activa'
     from public.decisiones d where d.id = d3));

  ------------------------------------------------------------ quien puede que
  perform pg_temp.comoUsuario_r(otro);
  perform pg_temp.anotar_r('no se retira una decision de otro',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null)',
      songplay, d3, 'De tapadillo.', d1)));

  perform pg_temp.comoAnon_r();
  perform pg_temp.anotar_r('anon no puede ni llamar a la funcion',
    pg_temp.falla_r(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null)',
      songplay, d3, 'Desde fuera.', d1)));

  perform pg_temp.comoUsuario_r(ruben);
  perform pg_temp.anotar_r('y siguen siendo tres decisiones',
    (select count(*) from public.decisiones where project_id = songplay) = 3);

  ----------------------------------------------------- y se lee igual de fuera
  perform set_config('role','postgres',true);
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  values (songplay, encode(sha256(convert_to('clave-retirar','UTF8')),'hex'), 'Prueba');

  perform pg_temp.comoAnon_r();
  perform pg_temp.anotar_r('la API ve la inactivacion, por numero',
    (public.decisiones_by_key('clave-retirar')->'decisiones'->0->'inactivacion'->>'sustituida_por')::int = 3);
  perform pg_temp.anotar_r('y la nueva sale como una decision mas',
    jsonb_array_length(public.decisiones_by_key('clave-retirar')->'decisiones') = 3);

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados_r order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados_r;
