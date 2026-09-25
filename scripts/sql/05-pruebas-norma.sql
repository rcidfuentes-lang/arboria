-- Ejercita la norma que recoge una decision, contra un Postgres de verdad.
--
-- Son tres cosas distintas y las tres se comprueban aqui porque las tres
-- dependen del mismo campo:
--
--   1. Una decision activa puede decir que norma la recoge, sin retirarse.
--   2. Una decision se puede retirar apuntando a esa norma en vez de a otra
--      decision, y la forma de siempre —apuntar a otra decision— sigue valiendo.
--   3. La lectura de fuera lo devuelve, y la importacion lo escribe.
--
-- Lo que mas importa de este fichero es lo que comprueba cuando algo sale mal:
-- que una decision no se puede retirar sin decir que ocupa su sitio, que un
-- apartado sin documento no entra, y que un fallo a la mitad de una
-- importacion no deja nada escrito.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados_n (n serial, prueba text, ok boolean, detalle text);
grant all on resultados_n to public;
grant all on sequence resultados_n_n_seq to public;

create or replace function pg_temp.anotar_n(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados_n (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.comoAnon_n() returns void language sql as $$
  select set_config('role','anon',true), set_config('request.jwt.claim.sub','',true);
$$;

create or replace function pg_temp.comoUsuario_n(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

create or replace function pg_temp.falla_n(sentencia text) returns boolean
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
  songplay uuid;
  d1 uuid;
  d2 uuid;
  d3 uuid;
  resumen jsonb;
  cuantas integer;
  sello timestamptz;
  documento jsonb;
  decision jsonb;
begin
  insert into auth.users (id) values (ruben);

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Songplay', 'songplay',
    '{"schemaVersion":1,"project":{"id":"songplay","name":"Songplay"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into songplay;

  perform pg_temp.comoUsuario_n(ruben);

  --------------------------------------------- una activa puede decir su norma
  insert into public.decisiones (project_id, decidido, fecha, motivo, tema,
                                 norma_documento, norma_apartado)
  values (songplay, 'Los informes llevan la cabecera de la norma.', '2026-06-02',
          'Sin cabecera no se sabe bajo que regla se escribio.', 'proceso',
          'docs/SP3-canon.md', '§7.5')
  returning id into d1;

  perform pg_temp.anotar_n('una decision activa puede nacer con su norma',
    (select d.estado = 'activa'
       and d.norma_documento = 'docs/SP3-canon.md'
       and d.norma_apartado = '§7.5'
     from public.decisiones d where d.id = d1));

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema,
                                 norma_documento)
  values (songplay, 'Un informe se cierra diciendo que se ha cambiado.', '2026-06-02',
          'Un informe sin cierre no se puede verificar.', 'proceso',
          'docs/SP3-canon.md')
  returning id into d2;

  perform pg_temp.anotar_n('el apartado es opcional',
    (select d.norma_apartado is null from public.decisiones d where d.id = d2));

  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (songplay, 'Una que no esta escrita en ninguna parte.', '2026-06-03',
          'Todavia no toca.', 'alcance')
  returning id into d3;

  perform pg_temp.anotar_n('y una decision puede no tener norma ninguna',
    (select d.norma_documento is null and d.norma_apartado is null
     from public.decisiones d where d.id = d3));

  ------------------------------------------------------ lo que la tabla no deja
  perform pg_temp.anotar_n('un apartado sin documento se rechaza',
    pg_temp.falla_n(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema, norma_apartado)
       values (%L, %L, %L, %L, %L, %L)',
      songplay, 'Media norma.', '2026-06-03', 'x', 'y', '§7.5')));

  perform pg_temp.anotar_n('un documento en blanco se rechaza',
    pg_temp.falla_n(format(
      'insert into public.decisiones (project_id, decidido, fecha, motivo, tema, norma_documento)
       values (%L, %L, %L, %L, %L, %L)',
      songplay, 'Norma vacia.', '2026-06-03', 'x', 'y', '   ')));

  perform pg_temp.anotar_n('una decision activa sigue sin poder llevar motivo de baja',
    pg_temp.falla_n(format(
      'update public.decisiones set motivo_inactivacion = %L where id = %L', 'porque si', d3)));

  perform pg_temp.anotar_n('una inactiva sin sustituta y sin norma se rechaza',
    pg_temp.falla_n(format(
      'update public.decisiones set estado = %L, motivo_inactivacion = %L where id = %L',
      'inactiva', 'ya no vale', d3)));

  ------------------------------------------------------------------- el rastro
  select updated_at into sello from public.decisiones where id = d1;

  update public.decisiones set norma_apartado = '§8.1' where id = d1;

  perform pg_temp.anotar_n('cambiar la norma deja rastro',
    (select count(*) from public.decisiones_historial h
     where h.decision_id = d1 and h.campo = 'norma_apartado'
       and h.antes = '§7.5' and h.despues = '§8.1') = 1);

  perform pg_temp.anotar_n('y mueve la marca de corregida',
    (select d.updated_at > sello from public.decisiones d where d.id = d1));

  select updated_at into sello from public.decisiones where id = d1;
  update public.decisiones set norma_apartado = '§8.1' where id = d1;
  perform pg_temp.anotar_n('y escribir lo mismo no la mueve',
    (select d.updated_at = sello from public.decisiones d where d.id = d1));

  update public.decisiones set norma_apartado = '§7.5' where id = d1;

  ------------------------------------------- retirar apuntando a una norma
  resumen := public.inactivar_decision(
    songplay, d2, 'Ya lo dice el canon; la decision sobra.',
    null, null,
    '{"documento": "docs/SP3-canon.md", "apartado": "§7.6"}'::jsonb);

  perform pg_temp.anotar_n('retirar por norma devuelve el numero y la norma',
    (resumen->>'retirada')::int = 2
      and resumen->>'norma' = 'docs/SP3-canon.md §7.6'
      and resumen->'sustituta' = 'null'::jsonb
      and not (resumen->>'creada')::boolean,
    resumen::text);

  perform pg_temp.anotar_n('la decision queda inactiva, sin sustituta y con su norma',
    (select d.estado = 'inactiva'
       and d.sustituida_por is null
       and d.norma_documento = 'docs/SP3-canon.md'
       and d.norma_apartado = '§7.6'
       and d.motivo_inactivacion = 'Ya lo dice el canon; la decision sobra.'
     from public.decisiones d where d.id = d2));

  perform pg_temp.anotar_n('y no ha nacido ninguna decision nueva',
    (select count(*) from public.decisiones where project_id = songplay) = 3);

  ------------------------------------------------- lo que no retira por norma
  select count(*) into cuantas from public.decisiones where project_id = songplay;

  perform pg_temp.anotar_n('una norma sin documento no retira nada',
    pg_temp.falla_n(format(
      'select public.inactivar_decision(%L, %L, %L, null, null, %L::jsonb)',
      songplay, d3, 'Porque si.', '{"apartado": "§7.5"}')));

  perform pg_temp.anotar_n('sin motivo tampoco',
    pg_temp.falla_n(format(
      'select public.inactivar_decision(%L, %L, %L, null, null, %L::jsonb)',
      songplay, d3, '   ', '{"documento": "docs/SP3-canon.md"}')));

  perform pg_temp.anotar_n('una norma y una decision a la vez, tampoco',
    pg_temp.falla_n(format(
      'select public.inactivar_decision(%L, %L, %L, %L, null, %L::jsonb)',
      songplay, d3, 'Porque si.', d1, '{"documento": "docs/SP3-canon.md"}')));

  perform pg_temp.anotar_n('una norma y una decision nueva, tampoco',
    pg_temp.falla_n(format(
      'select public.inactivar_decision(%L, %L, %L, null, %L::jsonb, %L::jsonb)',
      songplay, d3, 'Porque si.',
      '{"decidido": "Una que no deberia nacer.", "fecha": "2026-09-22",
        "motivo": "Ninguno.", "tema": "proceso"}',
      '{"documento": "docs/SP3-canon.md"}')));

  perform pg_temp.anotar_n('nada de eso ha escrito nada',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_n('y la 3 sigue activa y sin norma',
    (select d.estado = 'activa' and d.norma_documento is null
     from public.decisiones d where d.id = d3));

  ----------------------------------------- la forma de siempre no se ha roto
  resumen := public.inactivar_decision(songplay, d3, 'Lo dice mejor la 1.', d1, null);

  perform pg_temp.anotar_n('retirar apuntando a otra decision sigue valiendo',
    (resumen->>'retirada')::int = 3
      and (resumen->>'sustituta')::int = 1
      and resumen->'norma' = 'null'::jsonb,
    resumen::text);

  perform pg_temp.anotar_n('y esa queda apuntando a la decision, no a ninguna norma',
    (select d.sustituida_por = d1 and d.norma_documento is null
     from public.decisiones d where d.id = d3));

  -------------------------------------------- la sustituta nueva puede traerla
  resumen := public.inactivar_decision(
    songplay, d1, 'Se reescribe y ya queda en el canon.',
    null,
    '{"decidido": "La cabecera de la norma va en la primera linea.",
      "fecha": "2026-09-25",
      "motivo": "Asi se ve sin abrir el fichero entero.",
      "tema": "proceso",
      "norma": {"documento": "docs/SP3-canon.md", "apartado": "§7.5"}}'::jsonb);

  perform pg_temp.anotar_n('una sustituta que se escribe entera puede nacer con su norma',
    (select d.estado = 'activa'
       and d.norma_documento = 'docs/SP3-canon.md'
       and d.norma_apartado = '§7.5'
     from public.decisiones d
     where d.project_id = songplay and d.numero = (resumen->>'sustituta')::int));

  ---------------------------------------------------------- lo que se lee fuera
  perform set_config('role','postgres',true);
  insert into public.roadmap_api_keys (project_id, key_hash, label)
  values (songplay, encode(sha256(convert_to('clave-norma','UTF8')),'hex'), 'Prueba');

  perform pg_temp.comoAnon_n();
  documento := public.decisiones_by_key('clave-norma');

  select fila into decision
  from jsonb_array_elements(documento->'decisiones') as fila
  where (fila->>'numero')::int = 1;

  perform pg_temp.anotar_n('la lectura devuelve la norma como objeto',
    decision->'norma'->>'documento' = 'docs/SP3-canon.md'
      and decision->'norma'->>'apartado' = '§7.5',
    decision->>'norma');

  select fila into decision
  from jsonb_array_elements(documento->'decisiones') as fila
  where (fila->>'numero')::int = 2;

  perform pg_temp.anotar_n('una retirada por norma sale sin sustituida_por',
    decision->>'estado' = 'inactiva'
      and decision->'inactivacion'->'sustituida_por' = 'null'::jsonb
      and decision->'norma'->>'apartado' = '§7.6',
    decision::text);

  select fila into decision
  from jsonb_array_elements(documento->'decisiones') as fila
  where (fila->>'numero')::int = 3;

  perform pg_temp.anotar_n('una retirada por otra decision sigue saliendo con su numero',
    (decision->'inactivacion'->>'sustituida_por')::int = 1
      and decision->'norma' = 'null'::jsonb,
    decision::text);

  ------------------------------------------------------------- la importacion
  perform pg_temp.comoUsuario_n(ruben);

  -- Una que nace con su norma, y una que se retira porque esa norma la recoge.
  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "El acta de un nodo se cierra el mismo dia.",
     "fecha": "2026-06-04", "motivo": "Si no, se olvida que paso.", "tema": "proceso",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§9.1"}},
    {"decidido": "El acta se puede cerrar cuando se pueda.",
     "fecha": "2026-05-01", "motivo": "Habia prisa.", "tema": "proceso",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§9.1"},
     "inactiva": {"motivo": "Ya lo dice el canon."}}
  ]'::jsonb);

  perform pg_temp.anotar_n('la importacion escribe las dos y retira una por su norma',
    (resumen->>'escritas')::int = 2
      and (resumen->>'inactivadas')::int = 1
      and (resumen->>'normas')::int = 0,
    resumen::text);

  perform pg_temp.anotar_n('la retirada por norma queda sin sustituta',
    (select d.estado = 'inactiva' and d.sustituida_por is null
       and d.norma_documento = 'docs/SP3-canon.md'
     from public.decisiones d
     where d.project_id = songplay and d.fecha = '2026-05-01'));

  -- Volver a importar el mismo fichero no puede tocar nada.
  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "El acta de un nodo se cierra el mismo dia.",
     "fecha": "2026-06-04", "motivo": "Si no, se olvida que paso.", "tema": "proceso",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§9.1"}},
    {"decidido": "El acta se puede cerrar cuando se pueda.",
     "fecha": "2026-05-01", "motivo": "Habia prisa.", "tema": "proceso",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§9.1"},
     "inactiva": {"motivo": "Ya lo dice el canon."}}
  ]'::jsonb);

  perform pg_temp.anotar_n('el mismo fichero otra vez no escribe ni corrige nada',
    (resumen->>'escritas')::int = 0
      and (resumen->>'omitidas')::int = 2
      and (resumen->>'inactivadas')::int = 0
      and (resumen->>'normas')::int = 0,
    resumen::text);

  ---------------------------------- la norma si se le pone a una que ya estaba
  select updated_at into sello from public.decisiones where id = d3;

  resumen := public.importar_decisiones(songplay, format('[
    {"decidido": %s, "fecha": "2026-06-03", "motivo": "Todavia no toca.",
     "tema": "alcance",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§12.0"}}
  ]', to_json('Una que no esta escrita en ninguna parte.'::text))::jsonb);

  perform pg_temp.anotar_n('a una que ya estaba escrita se le pone la norma del fichero',
    (resumen->>'escritas')::int = 0
      and (resumen->>'omitidas')::int = 1
      and (resumen->>'normas')::int = 1,
    resumen::text);

  perform pg_temp.anotar_n('la norma queda escrita en la fila que ya estaba',
    (select d.norma_documento = 'docs/SP3-canon.md' and d.norma_apartado = '§12.0'
     from public.decisiones d where d.id = d3));

  perform pg_temp.anotar_n('y queda en el rastro, como cualquier correccion',
    (select count(*) from public.decisiones_historial h
     where h.decision_id = d3 and h.campo = 'norma_documento') = 1);

  perform pg_temp.anotar_n('lo demas de esa decision no se ha tocado',
    (select d.estado = 'inactiva' and d.sustituida_por = d1
       and d.motivo_inactivacion = 'Lo dice mejor la 1.'
     from public.decisiones d where d.id = d3));

  -- Y una entrada sin norma no borra la que hubiera.
  resumen := public.importar_decisiones(songplay, format('[
    {"decidido": %s, "fecha": "2026-06-03", "motivo": "Todavia no toca.",
     "tema": "alcance"}
  ]', to_json('Una que no esta escrita en ninguna parte.'::text))::jsonb);

  perform pg_temp.anotar_n('una entrada sin norma no borra la que la decision tenia',
    (resumen->>'normas')::int = 0
      and (select d.norma_apartado = '§12.0' from public.decisiones d where d.id = d3));

  ------------------------------------------------ lo que la importacion rechaza
  select count(*) into cuantas from public.decisiones where project_id = songplay;

  perform pg_temp.anotar_n('una entrada inactiva sin sustituta y sin norma tumba el fichero',
    pg_temp.falla_n(format(
      'select public.importar_decisiones(%L, %L::jsonb)', songplay, '[
        {"decidido": "Esta si deberia entrar.", "fecha": "2026-06-05",
         "motivo": "x", "tema": "y"},
        {"decidido": "Y esta se retira sin decir por quien.", "fecha": "2026-06-05",
         "motivo": "x", "tema": "y", "inactiva": {"motivo": "porque si"}}
      ]')));

  perform pg_temp.anotar_n('y no deja escrita ni la que iba antes',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  perform pg_temp.anotar_n('un apartado sin documento tumba el fichero',
    pg_temp.falla_n(format(
      'select public.importar_decisiones(%L, %L::jsonb)', songplay, '[
        {"decidido": "Con media norma.", "fecha": "2026-06-05",
         "motivo": "x", "tema": "y", "norma": {"apartado": "§1"}}
      ]')));

  perform pg_temp.anotar_n('sigue sin escribirse nada',
    (select count(*) from public.decisiones where project_id = songplay) = cuantas);

  ------------------------------------------------------------- quien puede que
  perform pg_temp.comoAnon_n();
  perform pg_temp.anotar_n('anon sigue sin poder retirar nada por norma',
    pg_temp.falla_n(format(
      'select public.inactivar_decision(%L, %L, %L, null, null, %L::jsonb)',
      songplay, d1, 'Desde fuera.', '{"documento": "docs/SP3-canon.md"}')));

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados_n order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados_n;
