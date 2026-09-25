-- Ejercita que la importacion retire decisiones que ya estan escritas, y que
-- una que ya estaba retirada no se vuelva a tocar.
--
-- La segunda vuelta de importar_decisiones ya sabia retirar una decision que
-- existia de antes; lo que no dejaba era la pantalla. Aqui se fija ese
-- comportamiento por escrito, para que no se pierda sin que nadie se entere.
--
-- Y se comprueba lo que si ha cambiado: hasta ahora, una decision que ya
-- estaba inactiva se reescribia si el fichero traia otro motivo u otra
-- sustituta. Ahora no se toca y se cuenta en "ya_inactivas". Retirar es un
-- acto, no un campo que se edita a ficherazos.
--
-- Se lanza con scripts/verificar-esquema.sh.

create temp table resultados_p (n serial, prueba text, ok boolean, detalle text);
grant all on resultados_p to public;
grant all on sequence resultados_p_n_seq to public;

create or replace function pg_temp.anotar_p(p text, o boolean, d text default '') returns void
language sql as $$ insert into resultados_p (prueba, ok, detalle) values (p, o, d); $$;

create or replace function pg_temp.comoUsuario_p(u uuid) returns void language sql as $$
  select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',u::text,true);
$$;

create or replace function pg_temp.falla_p(sentencia text) returns boolean
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
  resumen jsonb;
  sello timestamptz;
  cuantas integer;
begin
  insert into auth.users (id) values (ruben);

  insert into public.roadmap_projects (owner_id, name, slug, document)
  values (ruben, 'Songplay', 'songplay',
    '{"schemaVersion":1,"project":{"id":"songplay","name":"Songplay"},"ideas":[],"nodes":[]}'::jsonb)
  returning id into songplay;

  perform pg_temp.comoUsuario_p(ruben);

  -- Cuatro decisiones escritas de antes, como las que Ruben tiene en el decisor.
  insert into public.decisiones (project_id, decidido, fecha, motivo, tema)
  values (songplay, 'La primera, que se va a retirar.', '2026-01-01', 'x', 'proceso'),
         (songplay, 'La segunda, que ocupa su sitio.', '2026-02-01', 'x', 'proceso'),
         (songplay, 'La tercera, que tambien se retira.', '2026-01-15', 'x', 'alcance'),
         (songplay, 'La cuarta, que no se toca.', '2026-03-01', 'x', 'alcance');

  ------------------------------------------- retirar las que ya estan escritas
  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "La primera, que se va a retirar.", "fecha": "2026-01-01",
     "motivo": "x", "tema": "proceso",
     "inactiva": {"motivo": "Lo dice mejor la 2.", "sustituida_por": 2}},
    {"decidido": "La tercera, que tambien se retira.", "fecha": "2026-01-15",
     "motivo": "x", "tema": "alcance",
     "inactiva": {"motivo": "Tambien la recoge la 2.", "sustituida_por": 2}}
  ]'::jsonb);

  perform pg_temp.anotar_p('un fichero de solo decisiones ya escritas las retira',
    (resumen->>'escritas')::int = 0
      and (resumen->>'omitidas')::int = 2
      and (resumen->>'inactivadas')::int = 2
      and (resumen->>'ya_inactivas')::int = 0,
    resumen::text);

  perform pg_temp.anotar_p('las dos quedan inactivas, con su motivo y su sustituta',
    (select count(*) from public.decisiones d
      join public.decisiones s on s.id = d.sustituida_por
     where d.project_id = songplay and d.estado = 'inactiva' and s.numero = 2
       and d.numero in (1, 3)) = 2);

  perform pg_temp.anotar_p('y cada una deja su rastro, como cualquier correccion',
    (select count(*) from public.decisiones_historial h
      join public.decisiones d on d.id = h.decision_id
     where d.project_id = songplay and d.numero in (1, 3)) = 6);

  perform pg_temp.anotar_p('no ha nacido ninguna decision nueva',
    (select count(*) from public.decisiones where project_id = songplay) = 4);

  perform pg_temp.anotar_p('y la cuarta sigue activa y sin tocar',
    (select d.estado = 'activa' and d.updated_at = d.created_at
     from public.decisiones d where d.project_id = songplay and d.numero = 4));

  ------------------------------------------------ una ya retirada no se toca
  select updated_at into sello from public.decisiones
  where project_id = songplay and numero = 1;

  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "La primera, que se va a retirar.", "fecha": "2026-01-01",
     "motivo": "x", "tema": "proceso",
     "inactiva": {"motivo": "UN MOTIVO COMPLETAMENTE DISTINTO.", "sustituida_por": 4}}
  ]'::jsonb);

  perform pg_temp.anotar_p('una que ya estaba retirada se cuenta en ya_inactivas',
    (resumen->>'inactivadas')::int = 0 and (resumen->>'ya_inactivas')::int = 1,
    resumen::text);

  perform pg_temp.anotar_p('y no se le reescribe ni el motivo ni la sustituta',
    (select d.motivo_inactivacion = 'Lo dice mejor la 2.' and s.numero = 2
     from public.decisiones d join public.decisiones s on s.id = d.sustituida_por
     where d.project_id = songplay and d.numero = 1));

  perform pg_temp.anotar_p('ni se le mueve la marca de corregida',
    (select d.updated_at = sello from public.decisiones d
     where d.project_id = songplay and d.numero = 1));

  ------------------------------------------------------- nunca al reves
  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "La primera, que se va a retirar.", "fecha": "2026-01-01",
     "motivo": "x", "tema": "proceso"}
  ]'::jsonb);

  perform pg_temp.anotar_p('una entrada sin "inactiva" no reactiva la que estaba retirada',
    (select d.estado = 'inactiva' and d.motivo_inactivacion is not null
       and d.sustituida_por is not null
     from public.decisiones d where d.project_id = songplay and d.numero = 1)
      and (resumen->>'inactivadas')::int = 0,
    resumen::text);

  perform pg_temp.anotar_p('ni le borra nada',
    (select d.updated_at = sello from public.decisiones d
     where d.project_id = songplay and d.numero = 1));

  ------------------------------------ retirar y poner la norma en el mismo paso
  resumen := public.importar_decisiones(songplay, '[
    {"decidido": "La cuarta, que no se toca.", "fecha": "2026-03-01",
     "motivo": "x", "tema": "alcance",
     "norma": {"documento": "docs/SP3-canon.md", "apartado": "§4.2"},
     "inactiva": {"motivo": "Ya lo dice el canon."}}
  ]'::jsonb);

  perform pg_temp.anotar_p('una que ya estaba se puede retirar por su norma',
    (resumen->>'inactivadas')::int = 1 and (resumen->>'normas')::int = 1,
    resumen::text);

  perform pg_temp.anotar_p('y queda inactiva, sin sustituta y con su norma',
    (select d.estado = 'inactiva' and d.sustituida_por is null
       and d.norma_documento = 'docs/SP3-canon.md' and d.norma_apartado = '§4.2'
     from public.decisiones d where d.project_id = songplay and d.numero = 4));

  ------------------------------------------------------- lo que sigue sin valer
  select count(*) filter (where estado = 'inactiva') into cuantas
  from public.decisiones where project_id = songplay;

  perform pg_temp.anotar_p('una decision no se sustituye a si misma, tampoco importando',
    pg_temp.falla_p(format(
      'select public.importar_decisiones(%L, %L::jsonb)', songplay, '[
        {"decidido": "La segunda, que ocupa su sitio.", "fecha": "2026-02-01",
         "motivo": "x", "tema": "proceso",
         "inactiva": {"motivo": "porque si", "sustituida_por": 2}}
      ]')));

  perform pg_temp.anotar_p('un numero que no existe tumba el fichero entero',
    pg_temp.falla_p(format(
      'select public.importar_decisiones(%L, %L::jsonb)', songplay, '[
        {"decidido": "Esta si deberia entrar.", "fecha": "2026-06-05",
         "motivo": "x", "tema": "y"},
        {"decidido": "La segunda, que ocupa su sitio.", "fecha": "2026-02-01",
         "motivo": "x", "tema": "proceso",
         "inactiva": {"motivo": "porque si", "sustituida_por": 999}}
      ]')));

  perform pg_temp.anotar_p('y no deja escrita ni la que iba antes',
    (select count(*) from public.decisiones where project_id = songplay) = 4);

  perform pg_temp.anotar_p('la segunda sigue activa despues de todo lo que fallo',
    (select d.estado = 'activa' from public.decisiones d
     where d.project_id = songplay and d.numero = 2));

  perform pg_temp.anotar_p('y siguen siendo las mismas tres inactivas',
    (select count(*) filter (where estado = 'inactiva')
     from public.decisiones where project_id = songplay) = cuantas);

  perform set_config('role','postgres',true);
end;
$prueba$;

select n, case when ok then '  ok  ' else ' MAL  ' end as estado, prueba, detalle from resultados_p order by n;
select count(*) filter (where not ok) as fallos, count(*) as total from resultados_p;
