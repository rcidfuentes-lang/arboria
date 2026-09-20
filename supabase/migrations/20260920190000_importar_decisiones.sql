-- La importacion de decisiones, y una correccion en el rastro.
--
-- Escribir las decisiones "a mano" es escribirlas de una en una en el
-- formulario o traerlas en un fichero que sube Ruben en la aplicacion. Lo que
-- no hay, y sigue sin haber, es una ruta por la que escriban la API o el
-- conector: esta funcion se concede a authenticated y a nadie mas, asi que anon
-- —que es el rol con el que llaman /api/decisiones y /mcp— no puede ni verla.
--
-- Por que esto es una funcion de la base y no un bucle en la pantalla: una
-- importacion no puede quedarse a medias. Las sustituciones obligan a dos
-- vueltas —primero las altas, despues las bajas, porque una decision puede
-- senalar a otra que viene despues en el mismo fichero— y con dos vueltas
-- hechas desde el navegador, un fallo en la segunda deja escrito lo de la
-- primera. Aqui las dos vueltas son una sola transaccion: o entra el fichero
-- entero o no entra nada.
--
-- No es security definer, y eso es lo que se quiere: corre como quien llama, y
-- entonces las politicas de RLS que ya existen son las que deciden si ese
-- proyecto es suyo. La funcion no concede nada; solo agrupa.

-- --------------------------------------------------------------------------
-- Primero, el rastro: updated_at solo se mueve si algo cambia
-- --------------------------------------------------------------------------

-- Tal y como estaba, cualquier update sellaba updated_at aunque no cambiara
-- ningun campo, y entonces "corregida_el" decia que la decision se habia
-- tocado cuando no se habia tocado nada. Se nota al volver a importar el mismo
-- fichero: las decisiones que ya estaban aparecerian corregidas sin serlo.
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
-- La importacion
-- --------------------------------------------------------------------------

-- Recibe la lista ya leida y comprobada por la pantalla, con esta forma por
-- entrada:
--
--   {"ref": "tabla-propia" | null,
--    "decidido": "...", "fecha": "2026-09-20", "motivo": "...", "tema": "...",
--    "detalle": "..." | null, "nodo": "SP1.3" | null,
--    "inactiva": {"motivo": "...", "sustituida_por": "otro-ref" | 7} | null}
--
-- Que la pantalla ya lo haya comprobado no hace de menos a lo de aqui: esto se
-- vuelve a comprobar entero, porque lo que manda es la base. Lo que da la
-- pantalla es un mensaje entendible antes de escribir nada; lo que da esta
-- funcion es que no se pueda escribir mal.
--
-- Una decision que ya esta escrita no se toca ni se duplica: se considera la
-- misma cuando dice exactamente lo mismo el mismo dia. Asi un fichero se puede
-- volver a importar sin miedo, que es justo lo que hace falta cuando el primer
-- intento fallo por una entrada mala.
create function public.importar_decisiones(proyecto uuid, entradas jsonb)
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
  numeros integer[] := '{}';
  cual jsonb;
  objetivo uuid;
  fila public.decisiones;
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
      continue;
    end if;

    -- Todas entran activas. La baja es la segunda vuelta, porque la sustituta
    -- puede ser una entrada que todavia no existe.
    insert into public.decisiones (project_id, decidido, fecha, motivo, tema, detalle, nodo_id)
    values (
      proyecto,
      entrada->>'decidido',
      (entrada->>'fecha')::date,
      entrada->>'motivo',
      entrada->>'tema',
      nullif(pg_catalog.btrim(coalesce(entrada->>'detalle', '')), ''),
      nullif(pg_catalog.btrim(coalesce(entrada->>'nodo', '')), '')
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

    if pg_catalog.jsonb_typeof(cual) = 'number' then
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
    'numeros', pg_catalog.to_jsonb(numeros)
  );
end;
$$;

-- A authenticated y a nadie mas. anon es el rol con el que llaman el endpoint
-- de lectura y el servidor MCP: que no la tenga es lo que sostiene que por ahi
-- no se escribe.
revoke all on function public.importar_decisiones(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.importar_decisiones(uuid, jsonb) to authenticated;
