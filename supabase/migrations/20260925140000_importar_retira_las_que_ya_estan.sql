-- La importacion retira decisiones que ya estan escritas.
--
-- La segunda vuelta de importar_decisiones —la de las bajas— ya sabia retirar
-- una decision que ya existia: la primera vuelta guarda la fila que casa,
-- exista de antes o se acabe de escribir, y la segunda la inactiva igual. Lo
-- que no dejaba era la pantalla, que solo encendia el boton de importar si el
-- fichero traia decisiones nuevas o normas que poner. Un fichero de nueve
-- decisiones ya escritas, cada una con su "inactiva", se quedaba fuera.
--
-- Eso se arregla en la pantalla y no aqui. Lo que se arregla aqui es lo otro:
-- que una decision que YA estaba inactiva no se vuelva a tocar.
--
-- Hasta ahora la guarda solo saltaba cuando el motivo y la sustituta coincidian
-- exactamente con lo que ya habia, asi que un fichero que dijera otro motivo
-- reescribia la inactivacion sin que nadie lo pidiera. Ahora cualquier fila que
-- ya este inactiva se salta y se cuenta aparte, en "ya_inactivas".
--
-- Lo que eso quita, dicho a las claras: la errata en el motivo de una retirada
-- ya no se corrige reimportando el fichero. Se corrige abriendo la decision en
-- la pantalla, que es donde se ve lo que se esta cambiando y donde el cambio
-- queda en el rastro con nombre y apellidos.
--
-- Nada mas cambia. Ni columnas, ni restricciones, ni la forma de la lectura, ni
-- el formato del fichero. Las decisiones que ya estan escritas no se tocan.

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
  ya_inactivas integer := 0;
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

    -- Una decision que ya estaba inactiva no se vuelve a retirar, diga lo que
    -- diga el fichero. Antes solo se saltaba cuando el motivo y la sustituta
    -- coincidian exactamente, asi que un fichero con otro motivo reescribia la
    -- inactivacion por detras.
    --
    -- Retirar es un acto, no un campo que se edita a ficherazos: si el motivo
    -- de una retirada tiene una errata, se corrige abriendo la decision en la
    -- pantalla, que es donde se ve lo que se esta cambiando.
    if fila.estado = 'inactiva' then
      ya_inactivas := ya_inactivas + 1;
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
    'ya_inactivas', ya_inactivas,
    'normas', normas,
    'numeros', pg_catalog.to_jsonb(numeros)
  );
end;
$$;

-- A authenticated y a nadie mas, igual que antes: anon —que es el rol con el
-- que llaman el endpoint de lectura y el servidor MCP— no puede ni verla.
revoke all on function public.importar_decisiones(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.importar_decisiones(uuid, jsonb) to authenticated;
