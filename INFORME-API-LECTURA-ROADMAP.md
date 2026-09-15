# API de lectura del roadmap

Trabajo de Arboria. Arboria no tiene protocolo documental, así que este informe
no lleva cabecera de norma: la norma es de Songplay y este proyecto no lo es.

Fecha: 15/09/2026.
Punto de partida: `main` en `341ff33`, 28 commits.
Entregado: rama `api-lectura-roadmap`, dos commits, `HEAD` en `8aedb4d`.

```
8aedb4d  API de lectura del roadmap por clave de proyecto
66a7015  Extraer el modelo del roadmap a src/lib/roadmap-document.ts
341ff33  Add GitHub Action to keep Supabase project alive   <- main sigue aquí
```

Material de partida: `AUDITORIA-ARBORIA-material-para-decidir-la-api.md`, en la
raíz de `songplay/`. Sus hallazgos no se relitigan; cuando algo de aquí los
confirma o los mide, se dice.

**Nada de `songplay/` se ha tocado.** Se ha leído `docs/roadmap/roadmap.json`
como material de verificación, en solo lectura.

---

## 0. Las dos paradas del principio, y cómo se resolvieron

El encargo fijaba dos condiciones de parada y las dos se cumplieron. Se paró, se
informó, y Rubén decidió:

1. **La extracción no se podía hacer sin tocar `RoadmapEditor.tsx`**, donde
   había 25 líneas sin commitear de una sesión anterior. Decisión: seguir y
   commitear solo lo mío, dejando esas 25 líneas fuera de todo commit. Cómo se
   hizo, en §1.4.
2. **La dependencia de `DOMParser` es esencial.** Sanear `ideas[]` contra una
   lista blanca exige parsear HTML de verdad: lo que devuelve la función es
   `parsed.body.innerHTML`, el serializador del navegador, y no hay forma
   honesta de reproducirlo con manipulación de cadenas. Decisión: el servidor
   **rechaza** en lugar de arriesgarse a devolver unos bytes distintos. Cómo se
   implementó, en §1.2.

---

## 1. Qué se extrajo

### 1.1 El alcance

`normalizeRoadmapDocument()` no era una función suelta: era la punta de un
cierre transitivo de **19 funciones y 3 constantes** repartidas entre las líneas
52 y 411 de `RoadmapEditor.tsx`. Todas se movieron a
`src/lib/roadmap-document.ts`:

`statusOptions`, `allowedStatuses`, `allowedRichTextTags`, `statusLabel`,
`normalizeStatus`, `deriveBranchStatus`, `applyAutomaticStatuses`, `section`,
`legacyContent`, `normalizeNode`, `makeUniqueNodeId`, `ensureUniqueNodeIds`,
`sanitizeRichText`, `htmlToPlainText`, `normalizeIdea`, `ideasFromLegacyHtml`,
`normalizeRoadmapDocument`, `validateNodes`, `parseRoadmapJson`,
`parseRoadmapImportJson`, `stringifyRoadmapJson`.

Nueve de ellas las usa además el editor por su cuenta —`applyAutomaticStatuses`
en cinco sitios, `sanitizeRichText` en cuatro, `htmlToPlainText` en tres,
`statusOptions` en el `<select>` de estado—, así que el editor las importa de
vuelta. `ProjectList.tsx`, que hasta ahora las tomaba reexportadas desde
`RoadmapEditor`, ahora las toma del módulo.

Lo que **no** se movió, porque no está en el cierre: `statusProgress` y
`nodeProgress` (presentación), `createUniqueNodeId` (usa `window.crypto`, solo
el editor lo llama), `forceLeftToRightEditor`, `nodeMarkdown`, `markdownToHtml`,
`richTextActions`, y todo el lienzo.

`RoadmapEditor.tsx` pasa de 1 693 a 1 408 líneas. El módulo tiene 330.

### 1.2 El único cambio de conducta: la resolución del DOM

El traslado es literal. Comparado con el código de `HEAD`, en las 295 líneas
movidas hay **exactamente seis cambios**, y ninguno más:

- cuatro `export` añadidos, en `statusOptions`, `statusLabel`,
  `applyAutomaticStatuses` y `sanitizeRichText`/`htmlToPlainText`;
- las dos líneas que construían el parser.

```diff
-  const parsed = new window.DOMParser().parseFromString(html, 'text/html')
+  const parsed = new (resolveDomParser())().parseFromString(html, 'text/html')
```

`resolveDomParser()` busca `DOMParser` en `globalThis` de forma perezosa. En el
navegador eso es `window.DOMParser` y la conducta es idéntica. Donde no hay DOM
lanza `RichTextUnavailableError`.

Dos matices que importan:

- **El módulo se puede importar en Node sin DOM.** La resolución ocurre dentro
  de la función, no al cargar el módulo.
- **Un documento sin ideas con contenido no llega a esa ruta.** Las dos
  funciones salen antes con `if (!html.trim()) return ''`, y un `ideas: []` ni
  siquiera llama a `normalizeIdea`. El roadmap de Songplay tiene `ideas: []`, de
  modo que su normalización no toca el DOM ni una vez.

Por eso el rechazo del servidor no es un corte grueso por «tiene ideas»: es
exactamente «esto necesitaría un DOM y aquí no lo hay». Un roadmap con ideas de
cuerpo vacío se sirve bien; uno con una idea escrita devuelve `409`.

### 1.3 Cómo se verificó que la aplicación no cambió

Tres medidas independientes, todas sobre el roadmap de Songplay, todas con el
mismo resultado:

**a. Código.** Diferencia entre las franjas de `HEAD` y el módulo extraído: los
seis cambios de §1.2 y nada más.

**b. Node, contra el código de `HEAD`.** Se reconstruyó un módulo «antes» con
las mismas franjas sacadas de `HEAD` **sin ningún cambio** —ni siquiera los
`export`, porque las tres funciones que el arnés llama ya estaban exportadas— y
se pasaron ambos módulos por los dos caminos de exportación que tiene la
aplicación: el de la lista (`handleDownloadProject`) y el del editor
(`exportProject`). Cuatro juegos de datos:

| juego | camino | sha256 antes = después | bytes |
|---|---|---|---|
| `roadmap.json` de Songplay, 117 nodos | A y B | `b2eb8d46…334a9` | 78 433 |
| exportado suelto de Songplay, 118 nodos | A y B | `281e02b4…5bd18` | 78 257 |
| sintético: campos históricos, `status: done`, ids duplicados, sin `project` | A y B | `b591db93…5a15e` | 966 |
| sintético: ideas presentes con cuerpo vacío | A y B | `ec5c7bc7…cc9e5` | 401 |

Y `parseRoadmapJson` devuelve lo mismo, documento y lista de errores, en los
cuatro casos probados: válido, `schemaVersion` mala, id vacío y duplicado, y
JSON roto.

**c. El navegador, con la aplicación real.** Se montó `RoadmapEditor` con el
documento de Songplay, sin Supabase, en el servidor de desarrollo, y se pulsó
**el botón de exportar de verdad**, interceptando el blob:

```
songplay-ecosistema.json
78 433 bytes
sha256 b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9
termina en "}\n", indentación de 2
```

Y se ejercitó a mano lo que el encargo pedía comprobar:

- **Editar**: se cambió el título de `SP` y el árbol lo reflejó.
- **Importar**: se pegó una fase con `children`, `status: "done"` y un campo
  histórico `objective`. Entró como subfase, `done` se tradujo a «Cerrada» y
  `objective` apareció aplanado como `## Objetivo` dentro del contenido.
- **Ideas y saneado**, que es la ruta del `DOMParser`: se creó una idea, se
  escribió en ella, y se le inyectó markup prohibido. Resultado, idéntico a lo
  de siempre:

  | entra | sale |
  |---|---|
  | `<p style="color:red" onclick="alert(1)">` | `<p>` |
  | `<a href="http://malo">enlace</a>` | `enlace` |
  | `<b>negrita</b>` | `<b>negrita</b>` |
  | `<span class="x">span</span>` | `span` |
  | `<script>alert(2)</script>` | `alert(2)` |
  | `<img src=x onerror="alert(3)">` | *(desaparece)* |
- **Exportar**: la huella de arriba.

**Un resultado que no se buscaba y que conviene registrar: la huella de la
exportación coincide con la del fichero que ya está en el repositorio de
Songplay.**

```
b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  songplay/docs/roadmap/roadmap.json
b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  la exportación de Arboria
281e02b42f6eddf856f95ee2dea4f07d468a7a0a89b45044688769d951d5bd18  songplay/nuevo-proyecto-mu15nbxt.json
281e02b42f6eddf856f95ee2dea4f07d468a7a0a89b45044688769d951d5bd18  la exportación de Arboria
```

El normalizador es un punto fijo sobre esos ficheros: normalizar lo ya
normalizado no mueve un byte. Eso es lo que hace que la identidad byte a byte de
la API sea comprobable contra algo real y no contra sí misma.

### 1.4 Cómo se dejaron fuera las 25 líneas sin commitear

Las 25 líneas de Rubén —quitar el panel `.branch-help` y sus estilos— están en
la línea 1555 de `RoadmapEditor.tsx` y en la 1449 de `styles.css`. La extracción
trabaja entre la 52 y la 411. **No solapan.**

El commit de la extracción no se hizo desde el árbol de trabajo. Se construyó el
blob aplicando las mismas órdenes de borrado sobre **la versión de `HEAD`** del
fichero, y ese blob se indexó a mano con `git update-index`. El árbol de trabajo
conserva las dos cosas; el commit solo lleva una.

Resultado, comprobado después de cada commit:

```
 M src/components/RoadmapEditor.tsx
 M src/styles.css
 src/components/RoadmapEditor.tsx |  4 ----
 src/styles.css                   | 21 ---------------------
```

Las mismas dos líneas de estado y las mismas 25 líneas que al empezar.
`src/styles.css` no se ha tocado en absoluto: su huella sigue siendo
`f83e634ea415b7d74d5aba1d278e89d3542635328d670b55b61f686f44af847d`.

---

## 2. La forma técnica de la API, y por qué

**Una función de Netlify en Node**, en `netlify/functions/roadmap.mts`, expuesta
en `/api/roadmap`.

### Por qué no una Edge Function de Supabase, que es lo que se intentó en `419b3d3`

Tres razones, y la primera es la que decide:

1. **Se puede verificar en local, sin desplegar.** El encargo dice que si la
   comprobación de identidad byte a byte exige desplegar, hay que parar. Con
   Node no hace falta: el manejador se importa y se llama desde un script, y la
   huella de la respuesta se mide aquí mismo. Una Edge Function corre en Deno,
   que no está instalado en esta máquina, y habría dejado la comprobación 2
   bloqueada hasta que la desplegara Rubén.
2. **Viaja en el build que ya existe.** `netlify.toml` ya construye el sitio; una
   función en `netlify/functions/` se despliega con él. Las funciones de Supabase
   **no** viajan con el build de Netlify: necesitan `supabase functions deploy`,
   y hoy el único flujo de CI que hay es el latido diario, que no despliega nada.
   Esa es, muy probablemente, parte de por qué aquel intento nunca llegó a
   servicio.
3. **`tsc` la comprueba.** Se añadió `tsconfig.functions.json` al `tsc -b` de
   `npm run build`, de modo que la función y el módulo compartido se
   typecheckean juntos. Una función de Supabase queda fuera de ese build.

Sobre `tsconfig.functions.json` hay un detalle que conviene decir en voz alta:
lleva `"lib": ["ES2023", "DOM"]`. **DOM está ahí solo por los tipos**, porque el
módulo compartido nombra `DOMParser` en una firma. En ejecución la función corre
en Node y no hay DOM, que es justo lo que `RichTextUnavailableError` convierte en
un fallo visible. La independencia del navegador que importa es la de ejecución,
y esa es real.

### El contrato

```
GET /api/roadmap
Authorization: Bearer <clave del proyecto>
```

| situación | respuesta |
|---|---|
| clave válida | `200`, el documento con los bytes de la exportación |
| sin cabecera, `Bearer` vacío, clave inventada, clave revocada | `401 {"error":"unauthorized"}` |
| cualquier método que no sea `GET` | `405 {"error":"method_not_allowed"}` |
| el documento almacenado no es un roadmap | `409 {"error":"invalid_roadmap_document"}` |
| el documento tiene ideas con contenido | `409 {"error":"ideas_require_dom"}` |
| Supabase no responde | `502 {"error":"roadmap_lookup_failed"}` |

`Content-Type: application/json; charset=utf-8` y `Cache-Control: no-store` en
todas.

**La clave no viaja en la URL**, para que no acabe en registros de servidor ni en
el historial de nadie.

**Los cuatro casos de rechazo devuelven exactamente el mismo cuerpo.** Nada en la
respuesta permite saber si hay un proyecto detrás de una clave, ni cuántos hay,
ni si una clave existió alguna vez.

**No hay cabeceras CORS.** El consumidor es un script, no una página. Sin
`Access-Control-Allow-Origin` ningún navegador podrá leer esta respuesta desde
otro origen, aunque tenga la clave.

**El `409` de documento inválido no es celo.** El normalizador acepta cualquier
cosa y devuelve algo con la forma correcta: un objeto vacío le sale como un
roadmap sin fases. Servir eso como si fuera bueno sería entregar un roadmap
vacío de aspecto plausible, que es exactamente la clase de fallo silencioso que
este proyecto persigue. Así que se exige que lo almacenado ya sea un documento
—`schemaVersion === 1` y `nodes` un array— antes de normalizarlo.

### Por qué no vale devolver la columna `jsonb`

La auditoría lo razonaba; aquí está medido contra un Postgres de verdad (§5.3).
Postgres devolvió el documento con las claves de la raíz en este orden:

```
ideas, nodes, project, schemaVersion
```

que es el inverso del de la exportación. Dentro de cada nodo el orden coincide
por casualidad (`id, title, status, content, children`), tal y como preveía la
auditoría. Serializado con indentación de 2 y salto final, ese documento crudo
pesa **exactamente los mismos 78 433 bytes** y tiene una huella distinta:

```
b2eb8d46…334a9   roadmap.json del repositorio
7ab6587d…febb93  el jsonb crudo, sangrado igual
```

Mismo tamaño, bytes distintos. El generador de SP1.3.6 habría fallado y git
habría mostrado un cambio, sin que el roadmap hubiera cambiado.

---

## 3. Cómo se guardan y se comprueban las claves

**Una clave por proyecto.** La clave identifica el roadmap y la petición no
lleva identificador de proyecto. Quien tiene la clave de Songplay lee el de
Songplay y ningún otro; compartir una clave comparte ese roadmap y nada más.

Eso resuelve de paso el problema de los tres identificadores que la auditoría
documenta: no hay que elegir entre el uuid de la fila, el slug
(`nuevo-proyecto-mu15nbxt`) y `document.project.id` (`songplay-ecosistema`),
porque quien pide no nombra ninguno. La clave apunta a la fila.

**En la base no entra nunca la clave, solo su SHA-256 en hexadecimal.** Una copia
de la tabla `roadmap_api_keys` no permite leer ningún roadmap. La comprobación es
una búsqueda por el hash en una columna con índice único: lo que se compara nunca
es el secreto.

`scripts/generar-clave-de-lectura.mjs` genera 32 bytes aleatorios en base64url,
imprime la clave **una sola vez** y el `INSERT` que hay que ejecutar en Supabase
Studio. No toca la base, no lee credenciales y no escribe ningún fichero. Si la
clave se pierde, se revoca esa fila y se genera otra: no hay forma de
recuperarla, que es la propiedad que se busca.

Revocar es `update … set revoked_at = now()`, no un borrado: queda el registro de
que esa clave existió.

**Ninguna credencial de Rubén ha pasado por esta sesión.** Las claves que
aparecen en las verificaciones se generaron aquí, son de usar y tirar, nunca
tocaron ninguna base real y se borraron al terminar.

---

## 4. La migración

Hizo falta una: `supabase/migrations/20260915120000_create_roadmap_api_keys.sql`.
Sin ella la lectura por clave es imposible, porque la RLS actual solo deja leer
al dueño autenticado y para `anon` no hay ninguna política.

Tiene dos piezas.

### La tabla

```sql
create table public.roadmap_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.roadmap_projects(id) on delete cascade,
  key_hash text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

RLS activada y las mismas cuatro políticas que `roadmap_projects`, por la misma
condición: el dueño del proyecto. **Sin política para `anon`**, igual que la
tabla que ya había: para `anon` esta tabla no tiene ninguna fila.

No hay `last_used_at` ni ningún contador. Habría sido útil, y es una escritura:
la API es de solo lectura y no se le abre una puerta de escritura por comodidad.

### La función

```sql
create function public.roadmap_document_by_key(api_key text)
returns jsonb language sql stable security definer set search_path = ''
```

Es `security definer` porque quien pide el roadmap no es un usuario autenticado:
es una clave. **El alcance de ese privilegio es una columna de una fila** —el
`document` del proyecto al que apunta la clave— y nada más: ni `owner_id`, ni
`slug`, ni el uuid, ni las fechas, ni la tabla de claves, ni ningún otro
proyecto. Una clave válida abre un roadmap, no la tabla.

Devuelve `NULL` cuando la clave no existe, está revocada o su proyecto ya no
está; quien llama no puede distinguir los tres casos.

Detalles de la escritura: `search_path = ''` y todo cualificado, que es la forma
dura de escribir una función `security definer`. `sha256` es el builtin de
Postgres, así que **no hace falta `pgcrypto` ni ninguna extensión**. Y los
privilegios se ajustan a mano, porque Postgres concede `execute` a `public` por
defecto:

```sql
revoke all on function public.roadmap_document_by_key(text) from public;
grant execute on function public.roadmap_document_by_key(text) to anon;
```

Solo `anon`. Ni siquiera `authenticated`.

### Nunca la clave de servicio

El endpoint llama con la **clave anónima**, que ya es pública en el bundle
desplegado y por tanto no añade ninguna superficie. La clave de servicio se salta
la RLS entera y es una credencial de base de datos con privilegio total: el
roadmap de Songplay fija que Rubén no las proporciona por ningún canal
automatizado, y esa regla aplica aquí. El intento revertido la usaba; este no.

La función lee `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` del entorno y, si no
están, cae en `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`, que **ya
están puestas en Netlify** y que Netlify expone también a las funciones. Es decir:
no hace falta configurar ninguna variable nueva para que esto arranque.

---

## 5. Verificaciones

### 5.1 La exportación de la aplicación, idéntica antes y después

Hecho. §1.3. Tres medidas —diferencia de código, Node contra el código de `HEAD`
con cuatro juegos de datos, y el botón real en el navegador— todas con la misma
huella:

```
b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9   78 433 bytes
```

### 5.2 La respuesta de la API, byte a byte esa exportación

Hecho, por huella y sin desplegar. `npm run verificar-api` lo reproduce:

```bash
node scripts/verificar-api-roadmap.mjs ~/songplay/docs/roadmap/roadmap.json
```

El script simula la función `roadmap_document_by_key` —incluido el reordenado de
claves de `jsonb`— y llama al endpoint real. Sin argumentos usa un juego de datos
propio; con ficheros por argumento comprueba la identidad byte a byte contra
ellos. Arboria no depende de rutas de Songplay: el fichero lo pone quien ejecuta.

Resultado con los dos ficheros de Songplay:

```
fichero   b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  78433 bytes
respuesta b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  78433 bytes
fichero   281e02b42f6eddf856f95ee2dea4f07d468a7a0a89b45044688769d951d5bd18  78257 bytes
respuesta 281e02b42f6eddf856f95ee2dea4f07d468a7a0a89b45044688769d951d5bd18  78257 bytes
```

Y las propiedades de forma: llega con el orden de claves de `jsonb`, sale con el
de la exportación; indentación de 2; salto de línea final; acentos sin escapar;
`Cache-Control: no-store`; y ni `owner_id`, ni `slug`, ni fechas, ni envoltura.

### 5.3 Contra un Postgres de verdad

La verificación de 5.2 simula la base. Para no entregar SQL sin ejecutar, se
levantó un **clúster PostgreSQL 16 de usar y tirar en esta máquina**, con un
remedo mínimo de lo que Supabase pone de serie —esquema `auth`, `auth.users`,
`auth.uid()`, roles `anon` y `authenticated`, y los `GRANT` de tabla que Supabase
concede por defecto, para que lo que filtre sea la RLS y no el permiso—. Se
aplicaron **las dos migraciones**, la que ya había y la nueva, y se cargó el
roadmap de Songplay como documento.

Las dos migraciones se aplican sin error. Comportamiento medido:

| prueba | resultado |
|---|---|
| `anon` cuenta filas de `roadmap_projects` | **0** |
| `anon` cuenta filas de `roadmap_api_keys` | **0** |
| otro usuario autenticado, ambas tablas | **0** y **0** |
| el dueño, ambas tablas | **1** y **2** |
| `anon` intenta un `update` del proyecto | `UPDATE 0` |
| `anon` intenta darse de alta una clave | violación de política |
| `anon` llama a la función con la clave buena | devuelve el documento |
| `anon` llama con una clave inventada | `NULL` |
| `anon` llama con la clave revocada | `NULL` |
| `authenticated` llama a la función | **permiso denegado** |
| el `sha256` de Node coincide con el de Postgres | sí |

Y la cadena entera: documento guardado como `jsonb` → devuelto por la función
como `anon` → por el manejador real del endpoint:

```
estado                  200
sha256 de la respuesta  b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  78433 bytes
sha256 de roadmap.json  b2eb8d460a88fade9db2fa774f60081fab488222ad02cf960362e831643334a9  78433 bytes
```

Esto es lo que midió, de verdad y no por deducción, el orden de claves del
`jsonb` (§2) y lo que convierte la migración en SQL ejecutado en lugar de SQL
escrito. El clúster y sus claves se borraron al terminar.

**Lo que esta prueba no es:** PostgreSQL 16 local, no el 17 del proyecto alojado;
roles imitados, no los de Supabase; y el dueño de la función era superusuario,
mientras que en Supabase será `postgres`, que no lo es pero sí es dueño de las
tablas y por tanto también se salta la RLS. El comportamiento debería ser el
mismo. No es lo mismo que haberlo probado allí.

### 5.4 Sin clave, con clave inválida y con clave de otro proyecto

Hecho, en 5.2 y 5.3:

```
  ok   sin cabecera Authorization: 401 idéntico, sin decir si el proyecto existe
  ok   cabecera Bearer vacía:      401 idéntico
  ok   clave inventada:            401 idéntico
  ok   clave revocada:             401 idéntico
  ok   POST / PUT / PATCH / DELETE con clave buena: 405
  ok   una clave solo abre su proyecto
  ok   ideas con contenido: 409 ideas_require_dom, no unos bytes distintos
  ok   documento que no es un roadmap: 409, no un roadmap vacío plausible
```

### 5.5 La aplicación de Arboria sigue funcionando

Hecho, en el navegador y a mano: editar, importar, exportar, y las ideas con su
saneado. §1.3.c. Además `npm run build` (que es `tsc -b && vite build`) pasa, y
`npm run lint` no añade ningún aviso: siguen los dos de siempre en
`ProjectList.tsx`, en código que no se ha tocado. El bundle del cliente no cambia
de tamaño ni de huella al añadir la función, porque la función no entra en él.

### 5.6 Lo que no se ha podido verificar

**El endpoint desplegado.** No se ha desplegado nada. La función no ha corrido en
Netlify, la migración no se ha aplicado al proyecto alojado, y no existe ninguna
clave real. Todo lo de arriba se midió en local. **El despliegue lo hace Rubén**,
y hasta que lo haga la API no está en servicio.

### 5.7 Huellas de lo entregado

```
00f567b9b611bc9111c51c6b54befd86af9474bf1fb4c0a1be051a912331c6fe  src/lib/roadmap-document.ts
b98203f9e01b89e0fcbb7ce494e0b9294001f8ca6bc1f1f2744a53d89b162f87  netlify/functions/roadmap.mts
1e710ea8c9cd2666e66375f74b439c5e00e6f77423d67f99495d20a94fdb602e  supabase/migrations/20260915120000_create_roadmap_api_keys.sql
7065c999f44f64d50568f043f301a95dad13574a1125c3c453e55734a1b2a817  scripts/verificar-api-roadmap.mjs
f93415b772094071402a2bbd7ee8847d60c8cfa01b50078b37df06c72e382d15  scripts/generar-clave-de-lectura.mjs
```

---

## 6. Lo que se ha dejado como estaba, a propósito

Registrado, no arreglado:

- **El `slug` no es editable desde la aplicación.** El de Songplay sigue siendo
  `nuevo-proyecto-mu15nbxt`. La API no lo necesita ni lo expone.
- **Los tres identificadores siguen divergiendo**: el uuid de la fila, el `slug`
  y `document.project.id` (`songplay-ecosistema`). La clave por proyecto esquiva
  el problema; no lo cierra.
- **La divergencia entre `songplay/nuevo-proyecto-mu15nbxt.json` y
  `docs/roadmap/roadmap.json` sigue ahí**, en ambas direcciones. Se arregla sola
  cuando la API sustituya al ciclo manual.
- **La copia en `localStorage` sigue ganando en la aplicación.** Si una
  sincronización falla, la API leerá de la base una versión anterior y no tiene
  forma de saberlo.
- **`songplay/` no se ha tocado**: ni el fichero del roadmap, ni el generador, ni
  el verificador. Conectar Claude Code a la API es un encargo posterior.

---

## Cuestiones abiertas

1. ¿Quién aplica la migración al proyecto alojado, y cuándo? Hasta entonces la
   tabla de claves y la función no existen allí.

2. ¿Se fusiona `api-lectura-roadmap` a `main` o se rehace el trabajo directamente
   sobre `main`? La rama se hizo para no mover `main` mientras hubiera 25 líneas
   sin commitear en el árbol.

3. ¿Qué pasa con esas 25 líneas? Siguen sin commitear y sin autor. Mientras estén
   así, cualquier `git stash` o cambio de rama descuidado se las lleva.

4. ¿Es correcto que la API falle con `409` cuando el roadmap tenga ideas
   escritas, o hay que decidir ya el sustituto del `DOMParser`? Hoy Songplay
   tiene `ideas: []` y no se nota; el día que Rubén escriba una idea, la lectura
   se cae.

5. ¿Debe la respuesta poder decir que lo que devuelve quizá no es lo último, por
   la copia de `localStorage` sin sincronizar? Decirlo obliga a añadir algo a la
   respuesta, y eso rompe la identidad byte a byte.

6. ¿Cuántas claves por proyecto, y con qué política de rotación? Hoy no hay
   límite, no hay caducidad y no hay registro de uso.

7. ¿Hace falta límite de peticiones? Una clave se puede intentar adivinar contra
   la función; son 256 bits, pero no hay nada que cuente intentos.

8. ¿Debe `/api/roadmap` llevar cabeceras CORS? Hoy no las lleva, así que ninguna
   página web podrá leerla aunque tenga la clave.

9. ¿Qué hace Songplay con el fichero versionado una vez la API esté en servicio?
   D3 dice que se queda como copia; falta decidir quién lo actualiza y cada
   cuánto, ahora que ya no es la fuente.

10. ¿Se comprueba en algún sitio que la respuesta de la API sigue casando con lo
    que Arboria exporta, o se confía en que el módulo compartido lo garantiza?
    Hoy `npm run verificar-api` existe pero no lo ejecuta nadie automáticamente:
    no hay CI de construcción en Arboria.

11. La prueba de la migración se hizo contra PostgreSQL 16 con roles imitados y
    dueño superusuario. ¿Hace falta repetirla contra el proyecto real antes de
    darla por buena?

### Qué necesita hacer Rubén a mano para que esto quede en servicio

12. **Aplicar la migración** al proyecto alojado, con `supabase db push` o
    pegando el SQL en el editor de Supabase Studio. Requiere su acceso a la base;
    no hay ninguna vía por la que yo pueda hacerlo ni deba poder.

13. **Averiguar el uuid del proyecto de Songplay** en `roadmap_projects`. Se ve
    en Studio. No es el slug ni `document.project.id`.

14. **Generar la clave y darla de alta**:
    `node scripts/generar-clave-de-lectura.mjs <uuid> "Songplay"`, copiar la
    clave —se imprime una sola vez— y ejecutar en Studio el `INSERT` que el
    script imprime.

15. **Desplegar**, fusionando la rama o empujándola, y comprobar que Netlify
    construye la función. No hay que añadir ninguna variable de entorno: las
    `VITE_*` que ya están puestas sirven. Si prefiere nombres sin prefijo, la
    función también lee `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY`.

16. **Probar contra el sitio desplegado**:
    `curl -H "Authorization: Bearer <clave>" https://<el-sitio>/api/roadmap`, y
    comparar la huella de la respuesta con la de `docs/roadmap/roadmap.json`. Esa
    es la única comprobación que falta y que yo no puedo hacer.

17. **Decidir cómo llega la clave a quien la vaya a usar.** No por un canal donde
    quede escrita más tiempo del necesario. Yo no la he visto y no debo verla.
