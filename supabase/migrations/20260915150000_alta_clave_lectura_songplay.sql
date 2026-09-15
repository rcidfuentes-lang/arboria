-- Alta de la clave de lectura del roadmap de Songplay.
--
-- Esto es un dato, no esquema, y una migracion no es su sitio natural. Va aqui
-- porque es la unica via disponible para darla de alta sin que una credencial
-- de administracion de la base pase por un canal automatizado.
--
-- Lo que se guarda es el SHA-256 de la clave, nunca la clave. Publicar un
-- SHA-256 de 256 bits de entropia no revela nada: no se invierte y no se
-- fuerza. Este fichero puede vivir en un repositorio publico sin consecuencias.
--
-- Revocar sigue funcionando y es duradero:
--
--   update public.roadmap_api_keys set revoked_at = now()
--   where key_hash = '6220bbbd876ed54751794b66a0c6476c3ab2a4f7c436f6d63b8903d5f10db7e9';
--
-- La guarda "not exists" mira que exista la fila, no que este activa, asi que
-- una clave revocada no se vuelve a crear si esta migracion se reaplicara
-- sobre una base reconstruida.
--
-- El proyecto se localiza por el id de su nodo raiz, 'SP', que es estable.
-- No por document->'project'->>'id' ni por el slug: el primero se reescribe
-- importando un JSON y el segundo no es editable desde la aplicacion y hoy
-- vale 'nuevo-proyecto-mu15nbxt'. Si ninguno casa, no inserta nada y la
-- migracion pasa igual: es un alta, no una condicion del esquema.

insert into public.roadmap_api_keys (project_id, key_hash, label)
select p.id,
       '6220bbbd876ed54751794b66a0c6476c3ab2a4f7c436f6d63b8903d5f10db7e9',
       'Songplay'
from (
  select id
  from public.roadmap_projects
  where document->'nodes'->0->>'id' = 'SP'
  order by updated_at desc
  limit 1
) p
where not exists (
  select 1 from public.roadmap_api_keys k
  where k.key_hash = '6220bbbd876ed54751794b66a0c6476c3ab2a4f7c436f6d63b8903d5f10db7e9'
);
