-- Retirar una decision en un solo acto.
--
-- Hasta ahora, retirar una decision eran cuatro viajes: salir del formulario,
-- escribir la nueva, volver a la vieja, desplegar "Inactivar" y buscar la
-- sustituta en un selector. La pantalla ya lo hace en uno; lo que falta es que
-- la base tambien lo haga en uno, porque si no, el viaje corto se rompe por la
-- mitad y deja la nueva escrita sin que la vieja quede retirada.
--
-- Por eso esto es una funcion y no dos llamadas desde el navegador: es la
-- misma leccion de importar_decisiones. Dos escrituras que solo valen juntas
-- tienen que ir en una transaccion, y la transaccion que hay es la de la
-- llamada. O nace la nueva y la vieja queda inactiva apuntando a ella, o no se
-- escribe nada.
--
-- No cambia ninguna regla: la tabla ya exigia motivo y sustituta para estar
-- inactiva, y las sigue exigiendo ella. Aqui solo se comprueban antes, para
-- que el mensaje se entienda, y se agrupan las dos escrituras.
--
-- No es security definer, igual que importar_decisiones: corre como quien
-- llama, asi que son las politicas de RLS las que deciden si el proyecto es
-- suyo. La funcion no concede nada. Y se concede solo a authenticated, que es
-- lo que sostiene que ni /api/decisiones ni el conector —que llaman como
-- anon— puedan escribir por aqui.

-- La sustituta llega de una de las dos maneras, nunca de las dos:
--
--   sustituta: el id de una decision que ya existe en el proyecto, o
--   nueva:     {"decidido": "...", "fecha": "2026-09-20", "motivo": "...",
--               "tema": "...", "detalle": "..." | null, "nodo": "..." | null}
--
-- Devuelve los numeros, que es lo que la pantalla puede decirle a Ruben:
--
--   {"retirada": 7, "sustituta": 12, "creada": true}
create function public.inactivar_decision(
  proyecto uuid,
  decision uuid,
  por_que text,
  sustituta uuid default null,
  nueva jsonb default null
)
returns jsonb
language plpgsql
volatile
as $$
declare
  vieja public.decisiones;
  ocupante public.decisiones;
  creada boolean := false;
begin
  if pg_catalog.btrim(coalesce(por_que, '')) = '' then
    raise exception 'Di por que se retira.';
  end if;

  -- Una de las dos, y solo una. Las dos a la vez no es un descuido sin
  -- consecuencias: seria elegir por Ruben cual de las dos cuenta.
  if (sustituta is null) = (nueva is null or pg_catalog.jsonb_typeof(nueva) = 'null') then
    raise exception 'Hace falta una decision que la sustituya: o se escribe una nueva, o se elige una que ya exista.';
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

  if sustituta is not null then
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
    -- entra ninguna decision distinta de las que se escriben a mano.
    insert into public.decisiones (project_id, decidido, fecha, motivo, tema, detalle, nodo_id)
    values (
      proyecto,
      pg_catalog.btrim(coalesce(nueva->>'decidido', '')),
      (nueva->>'fecha')::date,
      pg_catalog.btrim(coalesce(nueva->>'motivo', '')),
      pg_catalog.btrim(coalesce(nueva->>'tema', '')),
      nullif(pg_catalog.btrim(coalesce(nueva->>'detalle', '')), ''),
      nullif(pg_catalog.btrim(coalesce(nueva->>'nodo', '')), '')
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
    'creada', creada
  );
end;
$$;

revoke all on function public.inactivar_decision(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.inactivar_decision(uuid, uuid, text, uuid, jsonb) to authenticated;
