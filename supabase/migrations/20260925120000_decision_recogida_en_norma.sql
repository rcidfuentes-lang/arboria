-- La norma que recoge una decision.
--
-- Hasta ahora una decision solo se podia retirar apuntando a otra decision,
-- porque el campo de sustitucion era el uuid de una fila de esta misma tabla.
-- Eso deja sin salida el caso que mas se repite en un proyecto maduro: la
-- decision sigue siendo verdad, pero ya no vive aqui, sino escrita en una
-- norma del repositorio. Sin poder senalar esa norma, la decision no se puede
-- quitar, porque la regla —decir por que se quita y que ocupa su sitio— no se
-- puede cumplir.
--
-- Un solo campo, no dos. "Inactivar apuntando a una norma" y "declarar que
-- norma recoge esta decision sin retirarla" son el mismo dato: esta decision
-- esta escrita en tal documento, tal apartado. Lo que cambia es si ademas se
-- retira. Por eso la norma vive en la decision y no dentro del bloque de
-- inactivacion, y vale igual estando activa que estando inactiva.
--
-- La regla de lectura cabe en una linea, y es la que se cuenta fuera:
--
--   si hay sustituida_por, eso es lo que ocupa su sitio;
--   si no lo hay, lo ocupa la norma.
--
-- Las dos cosas a la vez no son una contradiccion: es una decision que estaba
-- escrita en el canon y que ademas reemplazo otra decision posterior.
--
-- Nada de lo que ya hay se toca. Las columnas nacen nulas y sin valor por
-- defecto, asi que la tabla no se reescribe; la restriccion de la inactivacion
-- se relaja, y relajar un check no invalida ninguna fila escrita.

-- --------------------------------------------------------------------------
-- Las dos columnas
-- --------------------------------------------------------------------------

alter table public.decisiones
  -- El documento, tal y como se nombra en el repositorio que lo guarda:
  -- "docs/SP3-canon.md". Es texto suelto y no una clave ajena por lo mismo que
  -- nodo_id: ese documento vive en otro repositorio y Arboria no sabe —ni debe
  -- saber— si existe. Lo que se guarda es lo que Ruben escribio.
  add column norma_documento text,

  -- El apartado dentro de ese documento: "§7.5". Opcional, porque hay
  -- documentos cortos que recogen una decision enteros, y obligar a inventarse
  -- un apartado seria peor que no ponerlo.
  add column norma_apartado text;

alter table public.decisiones
  add constraint decisiones_norma_documento_acotado
    check (norma_documento is null
           or (btrim(norma_documento) <> '' and length(norma_documento) <= 400)),

  add constraint decisiones_norma_apartado_acotado
    check (norma_apartado is null
           or (btrim(norma_apartado) <> '' and length(norma_apartado) <= 200)),

  -- Un apartado sin documento no dice nada: "§7.5" de donde. Se rechaza en vez
  -- de guardarse a medias, porque a medias no se puede leer ni corregir.
  add constraint decisiones_apartado_con_documento
    check (norma_apartado is null or norma_documento is not null);

comment on column public.decisiones.norma_documento is
  'El documento del repositorio que recoge esta decision, si alguno la recoge. '
  'Vale con la decision activa —dice que ya esta escrita— y con la decision '
  'inactiva —y entonces, si no hay sustituida_por, es la norma la que ocupa su sitio.';

comment on column public.decisiones.norma_apartado is
  'El apartado dentro de ese documento. Opcional. No puede ir sin documento.';

-- --------------------------------------------------------------------------
-- La inactivacion admite dos sustitutos, no uno
-- --------------------------------------------------------------------------

-- Lo unico que cambia respecto a lo que habia: donde decia "y sustituida_por
-- is not null" ahora dice "y una de las dos". Todo lo demas se repite igual
-- porque un check se reemplaza entero.
alter table public.decisiones
  drop constraint decisiones_inactivacion_completa;

alter table public.decisiones
  add constraint decisiones_inactivacion_completa check (
    (estado = 'activa'
      and motivo_inactivacion is null
      and sustituida_por is null)
    or
    (estado = 'inactiva'
      and motivo_inactivacion is not null
      and btrim(motivo_inactivacion) <> ''
      and length(motivo_inactivacion) <= 20000
      and (sustituida_por is not null or norma_documento is not null))
  );

-- Ojo con lo que esto NO permite, y es a proposito: una decision activa sigue
-- sin poder arrastrar motivo de baja ni sustituta. La norma si puede estar,
-- porque la norma no es una baja.

-- --------------------------------------------------------------------------
-- El rastro tambien registra la norma
-- --------------------------------------------------------------------------

-- Si la norma no entrara en esta lista, cambiarla no dejaria rastro y ademas
-- updated_at no se moveria, asi que "corregida_el" diria que la decision no se
-- ha tocado cuando se acaba de tocar. Lo demas queda exactamente como estaba.
create or replace function public.decisiones_dejar_rastro()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  campo text;
  antes text;
  despues text;
  cambios integer := 0;
begin
  foreach campo in array array[
    'decidido', 'fecha', 'motivo', 'tema', 'detalle', 'nodo_id',
    'norma_documento', 'norma_apartado',
    'estado', 'motivo_inactivacion', 'sustituida_por'
  ] loop
    antes := pg_catalog.jsonb_extract_path_text(pg_catalog.to_jsonb(old), campo);
    despues := pg_catalog.jsonb_extract_path_text(pg_catalog.to_jsonb(new), campo);
    if antes is distinct from despues then
      cambios := cambios + 1;
      insert into public.decisiones_historial (decision_id, campo, antes, despues)
      values (new.id, campo, antes, despues);
    end if;
  end loop;

  if cambios > 0 then
    new.updated_at := pg_catalog.clock_timestamp();
  else
    new.updated_at := old.updated_at;
  end if;

  return new;
end;
$$;

revoke all on function public.decisiones_dejar_rastro() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- La lectura devuelve la norma
-- --------------------------------------------------------------------------

-- Una clave mas por decision, y nada mas. Es aditivo: quien ya lee /api/
-- decisiones o llama a leer_decisiones sigue encontrando todo lo que encontraba
-- donde lo encontraba.
--
-- La norma sale como objeto y no como una cadena "docs/SP3-canon.md §7.5"
-- porque quien la va a usar de verdad —el verificador de Songplay— tiene que
-- poder preguntar por el documento sin partir texto a ojo.
--
-- "inactivacion" no gana ningun campo. Una inactiva con sustituida_por nulo es
-- una a la que la sustituye su norma, y eso se lee mirando "norma", que esta
-- justo al lado. Escribirlo dos veces seria dos sitios que pueden discrepar.
create or replace function public.decisiones_de_proyecto(proyecto uuid)
returns jsonb
language sql
stable
as $$
  select pg_catalog.jsonb_build_object(
    'project', pg_catalog.jsonb_build_object(
      'id', p.document->'project'->>'id',
      'name', p.document->'project'->>'name'
    ),
    'decisiones', coalesce((
      select pg_catalog.jsonb_agg(fila order by fila->>'numero')
      from (
        select pg_catalog.jsonb_build_object(
          'numero', d.numero,
          'decidido', d.decidido,
          'fecha', d.fecha,
          'motivo', d.motivo,
          'tema', d.tema,
          'detalle', d.detalle,
          'nodo', d.nodo_id,
          'norma', case
            when d.norma_documento is not null then pg_catalog.jsonb_build_object(
              'documento', d.norma_documento,
              'apartado', d.norma_apartado
            )
            else null
          end,
          'estado', d.estado,
          'inactivacion', case
            when d.estado = 'inactiva' then pg_catalog.jsonb_build_object(
              'motivo', d.motivo_inactivacion,
              'sustituida_por', (
                select s.numero from public.decisiones s where s.id = d.sustituida_por
              )
            )
            else null
          end,
          'escrita_el', d.created_at,
          'corregida_el', case when d.updated_at > d.created_at then d.updated_at else null end,
          'correcciones', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'campo', h.campo,
                'antes', h.antes,
                'despues', h.despues,
                'cuando', h.cambiado_el
              ) order by h.cambiado_el, h.campo
            )
            from public.decisiones_historial h
            where h.decision_id = d.id
          ), '[]'::jsonb)
        ) as fila
        from public.decisiones d
        where d.project_id = proyecto
        order by d.numero
      ) as filas
    ), '[]'::jsonb)
  )
  from public.roadmap_projects p
  where p.id = proyecto;
$$;

revoke all on function public.decisiones_de_proyecto(uuid) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Retirar apuntando a una norma
-- --------------------------------------------------------------------------

-- Se borra y se vuelve a crear en vez de reemplazarse porque anadir un
-- parametro cambia la firma, y entonces "create or replace" no reemplaza nada:
-- deja las dos funciones vivas y cualquier llamada que no nombre el parametro
-- nuevo pasa a ser ambigua. Borrar primero es lo que evita ese estado.
--
-- Lo que esta desplegado mientras tanto no se rompe: PostgREST llama por
-- nombre de argumento, y el parametro nuevo lleva valor por defecto.
drop function public.inactivar_decision(uuid, uuid, text, uuid, jsonb);

-- La sustituta llega de una de las tres maneras, nunca de dos:
--
--   sustituta: el id de una decision que ya existe en el proyecto,
--   nueva:     {"decidido": "...", "fecha": "2026-09-20", "motivo": "...",
--               "tema": "...", "detalle": "..." | null, "nodo": "..." | null,
--               "norma": {"documento": "...", "apartado": "..."} | null}
--   norma:     {"documento": "docs/SP3-canon.md", "apartado": "§7.5" | null}
--
-- Las tres son legitimas y dicen cosas distintas. La tercera es la que faltaba:
-- la decision no la reemplaza otra decision, la recoge una norma.
--
-- Devuelve lo que la pantalla puede decirle a Ruben:
--
--   {"retirada": 7, "sustituta": 12, "norma": null, "creada": true}
--   {"retirada": 7, "sustituta": null, "norma": "docs/SP3-canon.md §7.5", "creada": false}
create function public.inactivar_decision(
  proyecto uuid,
  decision uuid,
  por_que text,
  sustituta uuid default null,
  nueva jsonb default null,
  norma jsonb default null
)
returns jsonb
language plpgsql
volatile
as $$
declare
  vieja public.decisiones;
  ocupante public.decisiones;
  creada boolean := false;
  hay_sustituta boolean;
  hay_nueva boolean;
  hay_norma boolean;
  documento text;
  apartado text;
begin
  if pg_catalog.btrim(coalesce(por_que, '')) = '' then
    raise exception 'Di por que se retira.';
  end if;

  hay_sustituta := sustituta is not null;
  hay_nueva := nueva is not null and pg_catalog.jsonb_typeof(nueva) <> 'null';
  hay_norma := norma is not null and pg_catalog.jsonb_typeof(norma) <> 'null';

  -- Una de las tres, y solo una. Dos a la vez no es un descuido sin
  -- consecuencias: seria elegir por Ruben cual de las dos cuenta.
  if (hay_sustituta::integer + hay_nueva::integer + hay_norma::integer) <> 1 then
    raise exception 'Hace falta una sola cosa que ocupe su sitio: o una decision nueva, o una que ya exista, o la norma que la recoge.';
  end if;

  select d.* into vieja
  from public.decisiones d
  where d.id = decision and d.project_id = proyecto;

  if not found then
    raise exception 'Esa decision no esta en este proyecto.';
  end if;

  if vieja.estado <> 'activa' then
    raise exception 'La decision % ya estaba inactiva.', vieja.numero;
  end if;

  if hay_norma then
    documento := nullif(pg_catalog.btrim(coalesce(norma->>'documento', '')), '');
    apartado := nullif(pg_catalog.btrim(coalesce(norma->>'apartado', '')), '');

    if documento is null then
      raise exception 'Di que documento la recoge.';
    end if;

    -- La norma se escribe en la propia decision, que es donde vive, y
    -- sustituida_por queda nula: lo que ocupa su sitio es la norma.
    update public.decisiones d
    set estado = 'inactiva',
        motivo_inactivacion = pg_catalog.btrim(por_que),
        sustituida_por = null,
        norma_documento = documento,
        norma_apartado = apartado
    where d.id = vieja.id;

    if not found then
      raise exception 'No se ha podido retirar la decision %.', vieja.numero;
    end if;

    return pg_catalog.jsonb_build_object(
      'retirada', vieja.numero,
      'sustituta', null,
      'norma', documento || coalesce(' ' || apartado, ''),
      'creada', false
    );
  end if;

  if hay_sustituta then
    select d.* into ocupante
    from public.decisiones d
    where d.id = sustituta and d.project_id = proyecto;

    if not found then
      raise exception 'La decision que la sustituye no esta en este proyecto.';
    end if;

    if ocupante.id = vieja.id then
      raise exception 'Una decision no se sustituye a si misma.';
    end if;
  else
    -- La nueva nace activa y con su numero, como cualquier otra: por aqui no
    -- entra ninguna decision distinta de las que se escriben a mano. Puede
    -- nacer ya con su norma, que es el caso de quien reescribe una decision
    -- sabiendo donde va a quedar escrita.
    insert into public.decisiones (
      project_id, decidido, fecha, motivo, tema, detalle, nodo_id,
      norma_documento, norma_apartado
    )
    values (
      proyecto,
      pg_catalog.btrim(coalesce(nueva->>'decidido', '')),
      (nueva->>'fecha')::date,
      pg_catalog.btrim(coalesce(nueva->>'motivo', '')),
      pg_catalog.btrim(coalesce(nueva->>'tema', '')),
      nullif(pg_catalog.btrim(coalesce(nueva->>'detalle', '')), ''),
      nullif(pg_catalog.btrim(coalesce(nueva->>'nodo', '')), ''),
      nullif(pg_catalog.btrim(coalesce(nueva->'norma'->>'documento', '')), ''),
      nullif(pg_catalog.btrim(coalesce(nueva->'norma'->>'apartado', '')), '')
    )
    returning * into ocupante;

    creada := true;
  end if;

  update public.decisiones d
  set estado = 'inactiva',
      motivo_inactivacion = pg_catalog.btrim(por_que),
      sustituida_por = ocupante.id
  where d.id = vieja.id;

  -- Si la RLS de update no dejase, no habria fila tocada y no habria fallo:
  -- se habria quedado la nueva escrita y la vieja activa, que es justo lo que
  -- esta funcion existe para que no pase.
  if not found then
    raise exception 'No se ha podido retirar la decision %.', vieja.numero;
  end if;

  return pg_catalog.jsonb_build_object(
    'retirada', vieja.numero,
    'sustituta', ocupante.numero,
    'norma', null,
    'creada', creada
  );
end;
$$;

revoke all on function public.inactivar_decision(uuid, uuid, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.inactivar_decision(uuid, uuid, text, uuid, jsonb, jsonb)
  to authenticated;

-- --------------------------------------------------------------------------
-- La importacion escribe la norma
-- --------------------------------------------------------------------------

-- Tres cosas cambian respecto a lo que habia, y ninguna afecta a un fichero
-- que no hable de normas:
--
-- 1. Una entrada puede traer "norma", y entonces la decision nace con ella.
--
-- 2. Una entrada que ya estaba escrita y trae una norma distinta de la que
--    tiene la fila, se la pone. Es la unica excepcion a "importar no pisa lo
--    que ya hay", y existe porque sin ella el camino natural para marcar cien
--    decisiones de golpe —exportar, anadir la norma, reimportar— no haria
--    nada: se contarian como ya escritas y la norma se perderia. Nunca al
--    reves: una entrada sin norma no borra la norma de una decision que la
--    tenga. Y no es un agujero nuevo en la doctrina: la segunda vuelta ya
--    inactivaba decisiones que estaban escritas de antes.
--
-- 3. "inactiva" ya no exige "sustituida_por". Si no lo trae, lo que ocupa el
--    sitio de la decision es la norma de la entrada, y sin norma la entrada se
--    rechaza: una decision no se retira sin decir que la sustituye.
create or replace function public.importar_decisiones(proyecto uuid, entradas jsonb)
returns jsonb
language plpgsql
volatile
as $$
declare
  entrada jsonb;
  posicion integer := 0;
  ref text;
  existente public.decisiones;
  nueva public.decisiones;
  ids jsonb := '{}'::jsonb;        -- ref del fichero -> id de la fila
  propias jsonb := '{}'::jsonb;    -- posicion -> id de la fila, para la segunda vuelta
  escritas integer := 0;
  omitidas integer := 0;
  inactivadas integer := 0;
  normas integer := 0;
  numeros integer[] := '{}';
  cual jsonb;
  objetivo uuid;
  fila public.decisiones;
  documento text;
  apartado text;
begin
  if pg_catalog.jsonb_typeof(entradas) <> 'array' then
    raise exception 'El fichero no trae una lista de decisiones.';
  end if;

  if pg_catalog.jsonb_array_length(entradas) = 0 then
    raise exception 'El fichero no trae ninguna decision.';
  end if;

  if pg_catalog.jsonb_array_length(entradas) > 500 then
    raise exception 'El fichero trae demasiadas decisiones de una vez.';
  end if;

  ------------------------------------------------------------------ altas
  for entrada in select * from pg_catalog.jsonb_array_elements(entradas) loop
    posicion := posicion + 1;
    ref := entrada->>'ref';

    documento := nullif(pg_catalog.btrim(coalesce(entrada->'norma'->>'documento', '')), '');
    apartado := nullif(pg_catalog.btrim(coalesce(entrada->'norma'->>'apartado', '')), '');
    if documento is null and apartado is not null then
      raise exception 'La entrada % da un apartado de norma sin decir de que documento.', posicion;
    end if;

    select d.* into existente
    from public.decisiones d
    where d.project_id = proyecto
      and pg_catalog.btrim(d.decidido) = pg_catalog.btrim(entrada->>'decidido')
      and d.fecha = (entrada->>'fecha')::date
    limit 1;

    if found then
      omitidas := omitidas + 1;
      propias := propias || pg_catalog.jsonb_build_object(posicion::text, existente.id);
      if ref is not null then
        ids := ids || pg_catalog.jsonb_build_object(ref, existente.id);
      end if;

      -- Lo unico que se le pone a una decision que ya estaba: la norma, y solo
      -- si la entrada la trae y dice otra cosa que la fila. El disparador lo
      -- deja en el rastro, como cualquier correccion.
      if documento is not null
         and (existente.norma_documento is distinct from documento
              or existente.norma_apartado is distinct from apartado) then
        update public.decisiones d
        set norma_documento = documento,
            norma_apartado = apartado
        where d.id = existente.id;
        normas := normas + 1;
      end if;

      continue;
    end if;

    -- Todas entran activas. La baja es la segunda vuelta, porque la sustituta
    -- puede ser una entrada que todavia no existe.
    insert into public.decisiones (
      project_id, decidido, fecha, motivo, tema, detalle, nodo_id,
      norma_documento, norma_apartado
    )
    values (
      proyecto,
      entrada->>'decidido',
      (entrada->>'fecha')::date,
      entrada->>'motivo',
      entrada->>'tema',
      nullif(pg_catalog.btrim(coalesce(entrada->>'detalle', '')), ''),
      nullif(pg_catalog.btrim(coalesce(entrada->>'nodo', '')), ''),
      documento,
      apartado
    )
    returning * into nueva;

    escritas := escritas + 1;
    numeros := numeros || nueva.numero;
    propias := propias || pg_catalog.jsonb_build_object(posicion::text, nueva.id);
    if ref is not null then
      ids := ids || pg_catalog.jsonb_build_object(ref, nueva.id);
    end if;
  end loop;

  ------------------------------------------------------------------ bajas
  posicion := 0;
  for entrada in select * from pg_catalog.jsonb_array_elements(entradas) loop
    posicion := posicion + 1;
    if entrada->'inactiva' is null or pg_catalog.jsonb_typeof(entrada->'inactiva') = 'null' then
      continue;
    end if;

    cual := entrada->'inactiva'->'sustituida_por';

    if cual is null or pg_catalog.jsonb_typeof(cual) = 'null' then
      -- La retira su norma. Ya esta escrita en la fila, de la primera vuelta.
      if nullif(pg_catalog.btrim(coalesce(entrada->'norma'->>'documento', '')), '') is null then
        raise exception 'La entrada % se inactiva y no dice que ocupa su sitio: ni otra decision en "sustituida_por", ni una norma en "norma".',
          posicion;
      end if;
      objetivo := null;
    elsif pg_catalog.jsonb_typeof(cual) = 'number' then
      -- Una decision que ya estaba escrita, por su numero.
      select d.id into objetivo
      from public.decisiones d
      where d.project_id = proyecto
        and d.numero = (cual#>>'{}')::integer;
      if objetivo is null then
        raise exception 'La entrada % dice que la sustituye la decision %, y no existe en este proyecto.',
          posicion, cual#>>'{}';
      end if;
    else
      objetivo := (ids->>(cual#>>'{}'))::uuid;
      if objetivo is null then
        raise exception 'La entrada % dice que la sustituye "%", y no hay ninguna entrada con ese ref.',
          posicion, cual#>>'{}';
      end if;
    end if;

    select d.* into fila from public.decisiones d
    where d.id = (propias->>(posicion::text))::uuid;

    -- Si ya estaba inactiva exactamente asi, no se toca: volver a importar el
    -- mismo fichero no puede dejar dicho que la decision se corrigio.
    if fila.estado = 'inactiva'
       and fila.motivo_inactivacion is not distinct from entrada->'inactiva'->>'motivo'
       and fila.sustituida_por is not distinct from objetivo then
      continue;
    end if;

    update public.decisiones d
    set estado = 'inactiva',
        motivo_inactivacion = entrada->'inactiva'->>'motivo',
        sustituida_por = objetivo
    where d.id = fila.id;

    inactivadas := inactivadas + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'escritas', escritas,
    'omitidas', omitidas,
    'inactivadas', inactivadas,
    'normas', normas,
    'numeros', pg_catalog.to_jsonb(numeros)
  );
end;
$$;

-- A authenticated y a nadie mas, igual que antes: anon —que es el rol con el
-- que llaman /api/decisiones y el conector— no puede ni verla.
revoke all on function public.importar_decisiones(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.importar_decisiones(uuid, jsonb) to authenticated;
