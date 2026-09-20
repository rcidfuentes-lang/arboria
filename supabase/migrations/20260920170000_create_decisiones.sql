-- El decisor: las decisiones de un proyecto de Arboria.
--
-- Cada proyecto tiene dos cosas: su arbol, que es el roadmap, y su decisor,
-- que es esto. Las decisiones las escribe Ruben a mano en la aplicacion.
-- Ninguna ruta de fuera escribe: ni la API, ni el conector.
--
-- Por que una tabla y no una clave mas dentro de document jsonb, que habria
-- sido mas barato: la respuesta de /api/roadmap es byte a byte la exportacion
-- de Arboria, y el generador del roadmap de Songplay lo comprueba. Anadir algo
-- al documento cambia esos bytes para todo el que ya lee. Una tabla aparte no
-- toca nada de lo que ya esta en servicio, y ademas permite exigir de verdad
-- lo que el decisor necesita: que la decision sustituta exista y sea del mismo
-- proyecto.
--
-- El reparto de permisos no se inventa nada nuevo: se cuelga de project_id,
-- que es a lo que ya apuntan tanto las claves de lectura como los tokens del
-- conector. La misma clave y el mismo token, el mismo proyecto, solo lectura.

-- --------------------------------------------------------------------------
-- La tabla
-- --------------------------------------------------------------------------

create table public.decisiones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.roadmap_projects(id) on delete cascade,

  -- El numero es la identidad de cara afuera: "la decision 7 de Songplay".
  -- El uuid no sale nunca de la base. Un numero corto y por proyecto es lo que
  -- hace legible una lectura del decisor, que es justo para lo que existe el
  -- conector, y lo que permite decir "la sustituye la 12" sin arrastrar uuids.
  numero integer not null,

  -- Que se decidio, con las palabras de Ruben. Texto plano: aqui no entra
  -- HTML. La garantia de que es plano no es una comprobacion de formato en la
  -- base —que rechazaria un "coste < 100" legitimo— sino que no hay en todo el
  -- camino un solo sitio que lo interprete como marcado: React escapa al
  -- pintarlo y la exportacion lo serializa como cadena JSON. Por eso tampoco
  -- hace falta el DOMParser que hoy tumba la lectura cuando hay ideas escritas.
  decidido text not null,

  -- La fecha del hecho, que no es cuando se escribe. Una decision se puede
  -- apuntar dias despues de tomarla, y lo que importa es cuando se tomo.
  -- Cuando se escribio esta en created_at, que es otra cosa y se guarda aparte.
  fecha date not null,

  motivo text not null,
  tema text not null,

  -- Donde esta el detalle, si lo hay: un acta, un documento, una direccion.
  detalle text,

  -- El nodo del roadmap al que toca la decision, si toca alguno. Es texto
  -- suelto y no una clave ajena a proposito: los ids de nodo se editan a mano
  -- en el editor y una importacion los reescribe, asi que una clave ajena
  -- convertiria un renombrado de fase en un error al guardar. Lo que se guarda
  -- es lo que Ruben escribio; si esa fase deja de existir, la decision sigue
  -- diciendo de que hablaba.
  nodo_id text,

  estado text not null default 'activa',

  -- Al inactivar, las dos obligatorias: por que se quita y cual ocupa su sitio.
  motivo_inactivacion text,
  sustituida_por uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, numero),

  -- No es redundante con la clave primaria: es lo que permite la clave ajena
  -- compuesta de abajo, que es como se exige que la sustituta sea del mismo
  -- proyecto y no de otro.
  unique (project_id, id),

  constraint decisiones_estado_valido
    check (estado in ('activa', 'inactiva')),
  constraint decisiones_decidido_con_texto
    check (btrim(decidido) <> '' and length(decidido) <= 20000),
  constraint decisiones_motivo_con_texto
    check (btrim(motivo) <> '' and length(motivo) <= 20000),
  constraint decisiones_tema_con_texto
    check (btrim(tema) <> '' and length(tema) <= 200),
  constraint decisiones_detalle_acotado
    check (detalle is null or length(detalle) <= 4000),
  constraint decisiones_nodo_acotado
    check (nodo_id is null or length(nodo_id) <= 200),

  -- El estado y la explicacion de la inactivacion van juntos o no van. Una
  -- decision activa no arrastra motivo de baja, y una inactiva no puede estar
  -- sin explicar ni sin sustituta: se quita porque otra ocupa su sitio.
  constraint decisiones_inactivacion_completa check (
    (estado = 'activa'
      and motivo_inactivacion is null
      and sustituida_por is null)
    or
    (estado = 'inactiva'
      and motivo_inactivacion is not null
      and btrim(motivo_inactivacion) <> ''
      and length(motivo_inactivacion) <= 20000
      and sustituida_por is not null)
  ),

  constraint decisiones_no_se_sustituye_a_si_misma
    check (sustituida_por is distinct from id),

  -- La sustituta existe y es del mismo proyecto. Con MATCH SIMPLE, que es el
  -- comportamiento por defecto, esto no se comprueba cuando sustituida_por es
  -- nulo, que es justo lo que hace falta para las decisiones activas.
  --
  -- Sin accion al borrar, a proposito: una decision que ocupa el sitio de otra
  -- no se puede quitar de en medio. Tampoco es que se borren —no hay politica
  -- de delete— pero si alguna vez se borra un proyecto entero, el cascade de
  -- project_id se lleva las dos filas a la vez y esto no estorba.
  foreign key (project_id, sustituida_por)
    references public.decisiones (project_id, id)
);

create index decisiones_project_id_idx on public.decisiones (project_id, numero);
create index decisiones_tema_idx on public.decisiones (project_id, tema);

-- --------------------------------------------------------------------------
-- El rastro de las correcciones
-- --------------------------------------------------------------------------

-- Una decision no se borra y no se reescribe en silencio: corregirla deja
-- dicho que decia antes.
--
-- Quien escribe aqui no es la aplicacion sino un disparador, y el disparador
-- es security definer. Eso no es un adorno: significa que quien corrige una
-- decision no puede elegir si deja rastro, ni retocar el rastro despues. Sobre
-- esta tabla la aplicacion solo tiene lectura.
create table public.decisiones_historial (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisiones(id) on delete cascade,
  campo text not null,
  antes text,
  despues text,
  -- clock_timestamp() y no now(): now() es la hora en que empezo la
  -- transaccion, asi que dos correcciones seguidas compartirian marca y el
  -- rastro no diria cual fue antes.
  cambiado_el timestamptz not null default clock_timestamp()
);

create index decisiones_historial_decision_idx
  on public.decisiones_historial (decision_id, cambiado_el);

-- --------------------------------------------------------------------------
-- Numeracion
-- --------------------------------------------------------------------------

-- El numero se asigna aqui y no en la aplicacion, para que sea consecutivo por
-- proyecto y para que la aplicacion no tenga que leer antes de escribir.
--
-- Es security definer porque asi cuenta sobre todas las filas del proyecto y
-- no sobre las que la RLS deje ver, que en la practica son las mismas pero no
-- por construccion. Si dos altas simultaneas pidieran el mismo numero, el
-- unique (project_id, numero) las para: una falla en alto en vez de que dos
-- decisiones compartan numero en silencio. Con un solo escribiente, que es lo
-- que hay, no llega a pasar.
create function public.decisiones_numerar()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.numero is null then
    select coalesce(pg_catalog.max(d.numero), 0) + 1
    into new.numero
    from public.decisiones d
    where d.project_id = new.project_id;
  end if;
  return new;
end;
$$;

create trigger decisiones_numerar_antes_de_insertar
before insert on public.decisiones
for each row execute function public.decisiones_numerar();

-- Nadie la llama a mano. Postgres no comprueba este privilegio al disparar un
-- disparador —lo comprueba al crearlo— asi que retirarlo no lo rompe, y deja
-- escrito que esta funcion no es una puerta.
revoke all on function public.decisiones_numerar() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- El disparador del rastro
-- --------------------------------------------------------------------------

-- Deja rastro de todo campo de contenido que cambie, no solo del texto. El
-- coste es el mismo y la pregunta "por que esta decision dice ahora otro tema"
-- se contesta igual de bien que "por que dice ahora otra cosa".
--
-- Tambien pone updated_at, que asi no depende de que quien escriba se acuerde.
-- Con clock_timestamp() por lo mismo que en la tabla del rastro: con now(),
-- una correccion hecha en la misma transaccion que el alta dejaria updated_at
-- igual que created_at, y entonces "corregida_el" mentiria diciendo que nunca
-- se toco.
create function public.decisiones_dejar_rastro()
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
begin
  new.updated_at := pg_catalog.clock_timestamp();

  foreach campo in array array[
    'decidido', 'fecha', 'motivo', 'tema', 'detalle', 'nodo_id',
    'estado', 'motivo_inactivacion', 'sustituida_por'
  ] loop
    antes := pg_catalog.jsonb_extract_path_text(pg_catalog.to_jsonb(old), campo);
    despues := pg_catalog.jsonb_extract_path_text(pg_catalog.to_jsonb(new), campo);
    if antes is distinct from despues then
      insert into public.decisiones_historial (decision_id, campo, antes, despues)
      values (new.id, campo, antes, despues);
    end if;
  end loop;

  return new;
end;
$$;

create trigger decisiones_dejar_rastro_al_corregir
before update on public.decisiones
for each row execute function public.decisiones_dejar_rastro();

revoke all on function public.decisiones_dejar_rastro() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Quien puede que
-- --------------------------------------------------------------------------

alter table public.decisiones enable row level security;
alter table public.decisiones_historial enable row level security;

-- Las mismas tres politicas que roadmap_projects y por la misma condicion, el
-- dueño del proyecto. La cuarta, la de borrar, no existe: las decisiones no se
-- borran. Se inactivan, diciendo por que y cual ocupa su sitio.
create policy "Users can read own decisiones"
on public.decisiones
for select
to authenticated
using (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

create policy "Users can create own decisiones"
on public.decisiones
for insert
to authenticated
with check (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

create policy "Users can update own decisiones"
on public.decisiones
for update
to authenticated
using (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.roadmap_projects p
    where p.id = project_id and p.owner_id = auth.uid()
  )
);

-- Del historial solo se lee. Lo escribe el disparador, que va por su cuenta.
create policy "Users can read own decisiones historial"
on public.decisiones_historial
for select
to authenticated
using (
  exists (
    select 1
    from public.decisiones d
    join public.roadmap_projects p on p.id = d.project_id
    where d.id = decision_id and p.owner_id = auth.uid()
  )
);

-- La falta de politica ya deja fuera lo que no esta permitido, pero Supabase
-- tiene puesto un ALTER DEFAULT PRIVILEGES que concede todo sobre las tablas
-- nuevas de public a anon y a authenticated. Retirar lo que sobra lo dice dos
-- veces y con otras palabras: aqui no se borra, y el rastro no se toca.
revoke delete on table public.decisiones from anon, authenticated;
revoke all on table public.decisiones_historial from anon, authenticated;
grant select on table public.decisiones_historial to authenticated;
revoke all on table public.decisiones from anon;

-- --------------------------------------------------------------------------
-- El armado del documento
-- --------------------------------------------------------------------------

-- Lo que leen la API y el conector. No se concede a nadie: toma un project_id
-- y quien la llamase podria pedir cualquier proyecto. Solo la llaman las dos
-- funciones de abajo, que corren como su dueño y no necesitan permiso.
--
-- De la fila del proyecto salen solo el id y el nombre que el propio documento
-- ya publica en /api/roadmap. Ni owner_id, ni slug, ni el uuid, ni las fechas.
--
-- El orden de las claves no importa: esto vuelve como jsonb, que Postgres
-- reordena, y quien sirve la respuesta la vuelve a serializar con el mismo
-- modulo que usa el boton de exportar. Es la misma leccion de roadmap_document_by_key.
create function public.decisiones_de_proyecto(proyecto uuid)
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
-- Las dos puertas de lectura
-- --------------------------------------------------------------------------

-- Gemela de roadmap_document_by_key, con la misma forma y el mismo alcance:
-- las decisiones del proyecto al que apunta la clave, y nada mas.
--
-- Devuelve null cuando la clave no existe, esta revocada o su proyecto ya no
-- esta. Quien llama no puede distinguir los tres casos. Un proyecto sin
-- ninguna decision no devuelve null, devuelve la lista vacia: son cosas
-- distintas y quien lee tiene que poder distinguirlas.
create function public.decisiones_by_key(api_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.decisiones_de_proyecto(k.project_id)
  from public.roadmap_api_keys k
  join public.roadmap_projects p on p.id = k.project_id
  where k.revoked_at is null
    and k.key_hash = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(api_key, 'UTF8')),
      'hex'
    )
  limit 1;
$$;

revoke all on function public.decisiones_by_key(text) from public, anon, authenticated;
grant execute on function public.decisiones_by_key(text) to anon;

-- La misma, por token del conector. Gemela de mcp_document_by_access_token:
-- el token ya esta atado a un proyecto, asi que las decisiones que abre son
-- las de ese proyecto y no hay forma de pedir otro.
create function public.mcp_decisiones_by_access_token(access_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.decisiones_de_proyecto(t.project_id)
  from public.mcp_oauth_tokens t
  join public.roadmap_projects p on p.id = t.project_id
  where t.revoked_at is null
    and t.access_expires_at > pg_catalog.now()
    and t.access_token_hash = pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(access_token, 'UTF8')), 'hex')
  limit 1;
$$;

revoke all on function public.mcp_decisiones_by_access_token(text) from public, anon, authenticated;
grant execute on function public.mcp_decisiones_by_access_token(text) to anon;
