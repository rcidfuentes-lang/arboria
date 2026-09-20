# Conector de Arboria para Claude (MCP remoto)

Trabajo de Arboria. Arboria no tiene protocolo documental, así que este informe
no lleva cabecera de norma: la norma es de Songplay y este proyecto no lo es.

Fecha: 20/09/2026.
Punto de partida: `main` en `ad0cccc`.
Construido y verificado. **Pendiente de que Rubén aplique la migración y
despliegue**, que es lo único que no se puede hacer desde aquí.

```
ff4da33  El origen publico sale de la peticion, con una salida de emergencia
a2f82ea  Verificar el conector: el protocolo sin desplegar y el SQL en un Postgres
98ca99a  Servidor MCP remoto por Streamable HTTP, con dos herramientas de lectura
a62f852  Retirar execute tambien a anon y a authenticated, no solo a public
950d21c  Servidor de autorizacion OAuth 2.1 para el conector
f93b404  Extraer la llamada RPC a Supabase a su propio modulo        (refactor)
21f53bd  Esquema del servidor de autorizacion OAuth del conector MCP
0d9eec8  Extraer la lectura del roadmap a un modulo compartido       (refactor)
ad0cccc  Alta de la clave de lectura de Songplay, y API en servicio  <- partida
```

**Nada de `songplay/` se ha tocado.** Se ha leído `docs/roadmap/roadmap.json`
como material de verificación, en solo lectura. Ese repositorio sigue en
`1bddd59` con los mismos dos ficheros modificados que ya tenía antes de empezar.

---

## Lo primero: la dirección y los pasos

La dirección que hay que pegar en claude.ai, después de desplegar:

```
https://arboria.rubenstuff.es/mcp
```

Los pasos, en claude.ai (también valen en la aplicación de escritorio y en el
móvil, porque el conector se guarda en la cuenta):

1. **Personalizar > Conectores**.
2. **+ > Añadir conector personalizado**.
3. Pegar `https://arboria.rubenstuff.es/mcp`. No hay que tocar «Configuración
   avanzada»: el cliente y la clave se dan de alta solos por registro dinámico.
4. **Añadir**, y después **Conectar**. Se abre una ventana de Arboria.
5. Si no hay sesión, iniciarla con el correo y la contraseña de siempre.
6. Elegir el proyecto en el desplegable y pulsar **Autorizar la lectura**.
7. Claude vuelve solo y el conector queda conectado, con dos herramientas:
   `leer_roadmap` y `leer_nodo`.

Para conectar un segundo proyecto se repite el proceso: sale otro conector, con
su propio permiso. Un permiso no alcanza a más de un proyecto.

Para retirar el permiso, en Supabase:

```sql
update public.mcp_oauth_tokens set revoked_at = now()
where project_id = '<uuid del proyecto>' and revoked_at is null;
```

---

## 0. Fase 0: lo que había, medido antes de tocar nada

**Cómo inicia sesión Arboria y cómo sabe de quién es cada proyecto.** Supabase
Auth con correo y contraseña (`src/components/Login.tsx`). Cada fila de
`roadmap_projects` tiene `owner_id` contra `auth.users`, y las cuatro políticas
de RLS son todas `owner_id = auth.uid()`. **Arboria sí sabe identificar a Rubén
como dueño de un proyecto**, así que la condición de parada del encargo no se
cumplió y se siguió.

**Dónde viven las claves por proyecto.** En `roadmap_api_keys`, que guarda
`key_hash` (SHA-256 en hexadecimal), nunca la clave. La única puerta de lectura
es `roadmap_document_by_key(api_key text)`, una función `security definer` con
`search_path` vacío, ejecutable por `anon`, cuyo alcance es exactamente una
columna de una fila.

**Si Netlify aguanta lo que hace falta.** Sí. Las funciones v2 (`.mts`) reciben
un `Request` y devuelven un `Response`, así que aceptan cualquier método y
cualquier cabecera; las reescrituras de `netlify.toml` colocan cada endpoint en
su dirección pública. Streamable HTTP no necesita nada más que POST, porque la
especificación permite contestar con un único objeto JSON en vez de un flujo
SSE, y aquí no hay nada que ir emitiendo. Las funciones no guardan estado entre
peticiones, cosa que el protocolo tampoco exige.

---

## 1. Por qué OAuth, y no la clave que ya existe

Los conectores personalizados de claude.ai solo admiten dos cosas: un servidor
sin autenticación, o un servidor con OAuth. No hay casilla para una clave fija.
Sin autenticación el roadmap sería público para cualquiera que supiera la
dirección, así que va con OAuth.

Eso obliga a que Arboria sea, además de servidor MCP, **su propio servidor de
autorización**: emisor, endpoint de autorización, endpoint de token y registro
dinámico de clientes. No es una preferencia de diseño; es lo que exige el
cliente que hay que conectar.

**La API con clave Bearer sigue exactamente igual.** Songplay la usa y no se ha
movido nada de ella. Las dos vías conviven, con credenciales de distinto tipo
que no se cruzan (se comprueba, ver §5).

---

## 2. El reparto: qué corre dónde, y por qué

| Pieza | Dónde | Por qué ahí |
|---|---|---|
| Endpoint MCP | `netlify/functions/mcp.mts` | Servidor a servidor, sin navegador. |
| Descubrimiento | `oauth-recurso.mts`, `oauth-metadatos.mts` | Documentos públicos, sin credenciales. |
| Registro de clientes | `oauth-registro.mts` | Público por especificación. |
| Endpoint de token | `oauth-token.mts` | Genera credenciales; necesita `node:crypto`. |
| **Pantalla de autorización** | `src/components/AutorizarConector.tsx` | **Es una pantalla de la aplicación, a propósito.** |
| Todo lo que decide | Funciones `security definer` de Supabase | Es donde está el dueño de los datos. |

La decisión que más conviene explicar es la quinta. El endpoint de autorización
de OAuth tiene que saber quién es Rubén y qué proyectos son suyos. Eso ya lo
sabe la aplicación: tiene la sesión de Supabase y la RLS le enseña sus
proyectos y ningún otro. Hacerlo en una función de servidor obligaría a manejar
la sesión de Supabase fuera del navegador —o, peor, a usar la clave de
servicio— para volver a averiguar algo que el navegador ya sabe.

Como consecuencia, **el código de autorización lo genera el navegador de Rubén y
no sale de él más que en la redirección a Claude**. A la base solo entra su
SHA-256. Ni Netlify ni ninguna función de Arboria llegan a ver nunca un código
en claro.

Arboria no tiene enrutador. `App.tsx` resuelve esa única ruta mirando
`window.location.pathname`. Meter un enrutador por una pantalla sería empezar la
casa por el tejado; si algún día hay una segunda ruta, se pone.

---

## 3. Las decisiones técnicas, una por una

### 3.1 Tokens opacos con el hash en la base, no JWT firmados

Un JWT evitaría una consulta, pero traería un secreto de firma nuevo que
custodiar en Netlify y dejaría la revocación en el aire. Los tokens opacos
siguen **el patrón que Arboria ya tiene** para las claves de lectura: 32 bytes
de aleatoriedad, en la base solo el SHA-256, revocación con un `update`. Cero
secretos nuevos y una forma menos de equivocarse.

### 3.2 Comprobar el token y traer el documento son la misma consulta

`mcp_document_by_access_token(access_token)` devuelve el documento del proyecto
al que apunta el token, o `null`. No hay forma de preguntar una cosa sin la
otra, y es a propósito: no existe ninguna función que diga «este token es
válido» sin entregar a la vez lo único que el token abre.

Es la gemela exacta de `roadmap_document_by_key`, con el mismo alcance: una
columna de una fila. Ni `owner_id`, ni `slug`, ni el uuid, ni las fechas.

### 3.3 PKCE se comprueba dentro de la base

La función de canje es pública para `anon`, porque el endpoint de token la llama
con la clave anónima, que ya es pública en el bundle desplegado. Si el endpoint
comparase el reto de PKCE y la base se fiara, cualquiera con el código podría
saltarse PKCE llamando directamente a la RPC. Así que la comparación está en el
SQL, y el endpoint solo genera credenciales, pregunta y traduce.

El consumo del código es **un único `update`** con todas las condiciones en el
`where`, de modo que dos canjes simultáneos del mismo código no pueden ganar los
dos.

### 3.4 Nunca la clave de servicio

Igual que en la API de lectura: todo se llama con la clave anónima contra
funciones `security definer` con `search_path` vacío y un alcance nombrado. Y
cada función se concede **solo al rol que la necesita**:

| Función | Quién la puede llamar |
|---|---|
| `mcp_register_client` | `anon` |
| `mcp_exchange_authorization_code` | `anon` |
| `mcp_refresh_access_token` | `anon` |
| `mcp_document_by_access_token` | `anon` |
| `mcp_client_for_authorization` | `authenticated` |
| `mcp_issue_authorization_code` | `authenticated` |

Las tres tablas nuevas tienen RLS activada **sin ninguna política** y los
privilegios de tabla retirados de `anon` y `authenticated`: no se llega a ellas
por PostgREST, ni leyendo ni escribiendo.

### 3.5 Un token, un proyecto

Igual que una clave de lectura. La petición MCP no lleva identificador de
proyecto y no hay manera de pedir otro. De cualquier otro proyecto el token no
sabe ni si existe: pedirle a `leer_nodo` un id de otro roadmap contesta lo mismo
que pedirle un id inventado.

### 3.6 Se hablan las dos eras del protocolo

MCP cambió de forma en la revisión `2026-07-28`: desapareció el handshake de
`initialize`, cada petición declara su versión en `_meta` y en la cabecera
`MCP-Protocol-Version`, los resultados llevan `resultType`, y el descubrimiento
es `server/discover`. Las revisiones `2025-03-26` a `2025-11-25` siguen usando
el handshake.

No se sabe cuál usa claude.ai hoy ni cuál usará dentro de seis meses, y un
servidor que solo habla una se queda mudo con la mitad de los clientes. Así que
habla las dos, y la era la decide cómo abre el cliente. En la era moderna se
validan además las cabeceras `Mcp-Method` y `Mcp-Name` contra el cuerpo, que es
obligatorio, y se contesta `-32020` si no casan.

### 3.7 Siempre un objeto JSON, nunca SSE; y sin sesiones

La especificación deja elegir, y aquí las dos herramientas devuelven de golpe
algo que ya está en memoria: no hay nada que ir emitiendo. Además, una función
de Netlify no es el sitio para sostener una conexión abierta. `GET` y `DELETE`
contra `/mcp` contestan 405, que es exactamente lo que el protocolo manda cuando
no hay flujo SSE ni sesiones que cerrar.

Ninguna respuesta asigna `Mcp-Session-Id`: cada petición se basta sola.

### 3.8 El origen sale de la petición

El emisor y la identidad del recurso no están escritos en ningún fichero de
configuración: se construyen con el protocolo y el host de la petición que
llega. Así el conector funciona igual en `arboria.rubenstuff.es`, en un
despliegue de prueba de Netlify y en local, sin que haya una dirección que
actualizar en dos sitios.

No se lee `X-Forwarded-Host`: la pone quien llama, y de ahí saldría el emisor
que se anuncia. Si algún día el despliegue diera un host distinto del público,
la variable de entorno `ARBORIA_ORIGEN` lo fuerza sin tocar código.

### 3.9 Registro dinámico, no Client ID Metadata Documents

La revisión de 2026 prefiere los Client ID Metadata Documents y marca el
registro dinámico como obsoleto, pero mantenido. Se ha quedado con el registro
dinámico por una razón concreta: el otro mecanismo implicaría que **Arboria
descargue un documento de una URL que elige quien llama**, y eso es una petición
saliente contra un sitio arbitrario disparada por un desconocido. Los metadatos
lo declaran explícitamente con `client_id_metadata_document_supported: false`,
para que el cliente no lo intente.

Registrarse no concede nada: solo devuelve un `client_id` con el que pedir
permiso. El permiso lo da Rubén en la pantalla, eligiendo el proyecto. Aun así
hay un tope de 20 altas por hora, para que un alta masiva no llene la tabla.

### 3.10 Rotación de refresh, y qué pasa cuando algo se reutiliza

La especificación exige rotar el refresh token en clientes públicos. Además:

- **Un código presentado dos veces** revoca el token que salió de la primera
  vez. Un código repetido significa que alguien más lo tiene.
- **Un refresh token ya rotado, presentado otra vez**, revoca la cadena entera.
  Lo mismo.
- **La caducidad del refresh no se alarga al renovar**: se hereda del primer
  eslabón. A los 90 días hay que volver a autorizar. Una autorización que se
  renueva sola para siempre no es una autorización, es una puerta abierta.

El token de acceso dura una hora, corto a propósito.

### 3.11 Lo que se devuelve es byte a byte la exportación

`leer_roadmap` usa `normalizeRoadmapDocument` y `stringifyRoadmapJson`, **los
mismos módulos** que el botón de exportar y que `/api/roadmap`. No es «un JSON
equivalente»: es el mismo. `leer_nodo` usa el mismo serializador sobre el nodo,
así que lo que devuelve es carácter por carácter el fragmento correspondiente de
la exportación.

Y cuando no se puede garantizar eso —un roadmap con ideas con contenido, que
necesitan un DOM que en Netlify no hay— **se falla en alto y se dice por qué**,
en vez de devolver unos bytes distintos. Igual que hace `/api/roadmap` con su
409 `ideas_require_dom`. La diferencia es que aquí el conector sigue
conectándose y listando herramientas: lo que falla es llamarlas, con el motivo
escrito.

---

## 4. Ficheros

### Nuevos

```
supabase/migrations/20260920120000_create_mcp_oauth.sql   3 tablas, 6 funciones
netlify/functions/mcp.mts                                 el endpoint MCP
netlify/functions/oauth-recurso.mts                       RFC 9728
netlify/functions/oauth-metadatos.mts                     RFC 8414
netlify/functions/oauth-registro.mts                      RFC 7591
netlify/functions/oauth-token.mts                         OAuth 2.1
netlify/lib/mcp-servidor.ts                               el protocolo, sin HTTP
netlify/lib/http.ts                                       CORS, JSON, credenciales
netlify/lib/supabase-rpc.ts                               llamada RPC (refactor)
netlify/lib/roadmap-lectura.ts                            lectura del documento (refactor)
src/lib/mcp-conector.ts                                   rutas y descubrimiento
src/components/AutorizarConector.tsx                      la pantalla de autorización
scripts/verificar-mcp.mjs                                 verificación del protocolo
scripts/verificar-esquema-mcp.sh                          verificación del SQL
scripts/sql/00-supabase-simulado.sql
scripts/sql/01-pruebas-oauth.sql
```

### Cambiados

```
netlify/functions/roadmap.mts    pasa a usar el módulo compartido; mismos status
netlify.toml                     rutas nuevas, todas antes del comodín de la SPA
src/App.tsx                      11 líneas: la ruta /oauth/autorizar
tsconfig.functions.json          incluye netlify/ entero, no solo las funciones
package.json                     dos scripts de verificación
```

Los dos refactores van en sus propios commits (`0d9eec8`, `f93b404`), antes de
cualquier función nueva, y `npm run verificar-api` sigue en verde sin tocarlo.

---

## 5. Fase 2: verificaciones

Tres niveles, porque son tres cosas que no se pueden comprobar igual.

### 5.1 El SQL, contra un PostgreSQL 17 de verdad

```bash
npm run verificar-esquema-mcp
```

Levanta un clúster de usar y tirar, reproduce el `ALTER DEFAULT PRIVILEGES` que
tiene puesto Supabase, aplica **las cuatro migraciones** y ejercita las
funciones cambiando de rol y de usuario como lo hace PostgREST. 28 de 28.

Esto **encontró dos fallos reales** que ninguna revisión de código había visto:
`anon` podía llamar a la emisión de códigos de autorización y cualquier usuario
con sesión podía llamar a la lectura por token. Causa: Supabase concede
`execute` a `anon` y a `authenticated` sobre toda función nueva de `public`, y
`revoke all ... from public` no quita esa concesión porque `public` es otra
cosa. Corregido en `a62f852`, que de paso arregla el mismo descuido en
`roadmap_document_by_key`, que lo tenía desde que se creó.

### 5.2 El protocolo, sin desplegar

```bash
npm run verificar-mcp
npm run verificar-mcp -- ../songplay/docs/roadmap/roadmap.json
```

Simula las funciones de la base —incluyendo que `jsonb` reordena las claves de
todo objeto por longitud y luego por bytes— y llama a **los endpoints reales**.
86 comprobaciones, todas en verde:

- **Descubrimiento**: el recurso se identifica como `/mcp`, apunta a Arboria
  como servidor de autorización, solo PKCE S256, solo clientes públicos, solo
  `authorization_code` y `refresh_token`. Los metadatos valen también en la ruta
  con `/mcp` detrás. El preflight de CORS deja pasar las cabeceras del protocolo
  y expone `WWW-Authenticate`.
- **Sin token**: 401 con el reto apuntando a los metadatos del recurso. `GET`,
  `DELETE` y `PUT` contra `/mcp`: 405.
- **Origin**: una página cualquiera, 403; `claude.ai` y el inspector en local
  pasan.
- **Registro**: alta correcta sin secreto de cliente; una redirección `http` que
  no es localhost, rechazada.
- **Autorización**: otro usuario no puede conceder un proyecto ajeno; sin sesión
  no se concede nada; una redirección no registrada no se concede y la pantalla
  no llega ni a ofrecerla.
- **Canje**: verificador PKCE equivocado, otra redirección, o un `resource` de
  otro servidor: rechazados. El correcto emite `access` y `refresh`, y en la
  base solo está el SHA-256.
- **Un código se usa una vez**: el segundo canje falla y revoca el token que
  salió del primero.
- **Las dos eras**: `initialize` negocia la versión que pide el cliente y no
  asigna sesión; `server/discover` anuncia `2026-07-28` y marca el resultado
  como completo; falta `Mcp-Method` → `-32020`; versión desconocida → `-32022`
  con la lista de las que sí.
- **Las herramientas**: hay exactamente dos y las dos leen; una herramienta
  inventada falla; `resources/write`, `tools/update` y `roadmap/escribir` no
  existen.
- **Aislamiento**: el token del otro proyecto lee el otro proyecto, y pedirle un
  nodo del de Songplay contesta sin decir que ese nodo existe en otra parte.
- **Rechazo con la misma cara**: sin token, con uno inventado o con basura,
  siempre el mismo 401.
- **Caducidad y renovación**: a la hora el token deja de valer; el refresh
  renueva y rota; reutilizar el viejo revoca la cadena entera, incluido el
  token nuevo.
- **Nada escribe**: en todo el recorrido por `/mcp`, la única función de la base
  a la que se llega es `mcp_document_by_access_token`, y el documento guardado
  no cambia.

### 5.3 Byte a byte, con el roadmap de verdad

Contra `songplay/docs/roadmap/roadmap.json`, 83 968 bytes:

```
fichero       82320187073320fc23cea507a280e9ae843579879a459b7232633aef99211295
/api/roadmap  82320187073320fc23cea507a280e9ae843579879a459b7232633aef99211295
leer_roadmap  82320187073320fc23cea507a280e9ae843579879a459b7232633aef99211295
```

El mismo SHA-256 y el mismo tamaño en las tres. Y las credenciales no se cruzan:
un token del conector no abre `/api/roadmap`, y una clave de lectura no abre el
conector.

### 5.4 La aplicación y la API de siempre

- `npm run verificar-api`: en verde, sin tocar el script.
- `npm run build`: compila.
- `npm run lint`: los mismos tres avisos de dependencias de hooks que ya había
  (dos en `ProjectList.tsx`, preexistentes; uno en la pantalla nueva, del mismo
  tipo y por la misma razón: las dependencias son parámetros de la URL, que no
  cambian mientras la página está abierta).
- El único cambio en la aplicación son 11 líneas en `App.tsx`, después de las
  dos guardas que ya había. Sin esa ruta en el camino, `App.tsx` se comporta
  exactamente como antes.

---

## 6. Lo que falta para que esté en servicio

Esto no se puede hacer desde aquí: hace falta acceso a Supabase y a Netlify.

1. **Aplicar la migración.** `supabase db push`, o pegar
   `supabase/migrations/20260920120000_create_mcp_oauth.sql` en el editor SQL de
   Supabase Studio.
2. **Desplegar** (`git push` a `main`, si Netlify está enganchado a la rama).
3. **Comprobar el descubrimiento**, que es lo primero que mira Claude:

   ```bash
   curl -s https://arboria.rubenstuff.es/.well-known/oauth-protected-resource
   ```

   Tiene que decir `"resource": "https://arboria.rubenstuff.es/mcp"`. Si dijera
   otro host, poner `ARBORIA_ORIGEN=https://arboria.rubenstuff.es` en las
   variables de entorno de Netlify y volver a desplegar.

   ```bash
   curl -s https://arboria.rubenstuff.es/.well-known/oauth-authorization-server
   curl -si -X POST https://arboria.rubenstuff.es/mcp | head -3
   ```

   La última tiene que dar `401` con la cabecera `WWW-Authenticate`.

4. **Comprobar que la API de siempre no se ha movido:**

   ```bash
   curl -s -H "Authorization: Bearer <la clave de Songplay>" \
     https://arboria.rubenstuff.es/api/roadmap | shasum -a 256
   ```

5. **Añadir el conector** en claude.ai con los pasos del principio.

---

## Cuestiones abiertas

1. **El flujo completo contra el servidor desplegado, con un cliente MCP real,
   está sin hacer.** Es lo único de la Fase 2 que falta, y falta porque no hay
   nada desplegado todavía: la migración no está aplicada y el código no está
   subido. Todo lo demás se ha verificado, pero contra los manejadores y contra
   un Postgres local, no contra el despliegue. Los pasos del §6 son
   exactamente esa comprobación.

2. **La pantalla de autorización no se ha visto funcionar en un navegador.**
   Llama a Supabase directamente con la sesión del usuario, así que no se puede
   ejercitar sin una base con la migración aplicada. Su lógica está verificada
   (las dos funciones que llama están probadas contra Postgres real), pero el
   render y la redirección no. Es lo primero que hay que mirar al probar el
   paso 5.

3. **Qué versión del protocolo habla claude.ai no se ha podido averiguar.** Por
   eso el servidor habla las dos eras. Si al conectar fallara, lo que hay que
   mirar en los registros de la función `mcp` es qué `MCP-Protocol-Version`
   llega y si viene `_meta` en el cuerpo.

4. **La validación de `Origin` es una apuesta.** La especificación obliga a
   validarla, pero Claude se conecta desde sus servidores y probablemente no
   mande `Origin` en absoluto. Si lo mandara desde un dominio que no esté en la
   lista (`claude.ai`, `claude.com` y sus subdominios, el propio origen y
   localhost), el conector daría 403. Es el sitio donde primero miraría si algo
   falla de forma inexplicable, y se arregla añadiendo el host a
   `origenPermitido` en `netlify/functions/mcp.mts`.

5. **No hay pantalla para ver ni revocar permisos concedidos.** Hoy se revoca
   con el `update` del principio de este informe. Añadir una lista de conectores
   autorizados junto a la de proyectos sería el siguiente paso natural, pero
   sería función nueva y no estaba en el encargo.

6. **Los tokens caducados no se borran solos.** Los códigos sí: la emisión de un
   código barre los que llevan más de un día caducados, porque es el único sitio
   por donde crece esa tabla. Los tokens se quedan, revocados o caducados, y son
   el rastro de qué se autorizó y cuándo. Con un conector y un proyecto eso son
   unas pocas filas al año; si algún día molestara, un borrado por
   `refresh_expires_at` lo resuelve.

7. **`leer_nodo` no tiene forma de buscar por título.** Devuelve un nodo por id
   exacto, y cuando no lo encuentra enumera los ids disponibles para que el
   modelo se corrija. Es suficiente para el uso previsto, pero si el roadmap
   creciera mucho, esa lista se hace larga y una herramienta de búsqueda tendría
   sentido. Se ha dejado fuera porque el encargo pedía dos herramientas.

8. **El alcance es uno solo, `roadmap:leer`, y no se negocia.** Si un cliente
   pide otro alcance, se ignora y se concede ese. Distinguir alcances no tiene
   sentido mientras solo haya lectura; si algún día hubiera escritura —que hoy
   no la hay y es la decisión que manda— esto habría que rehacerlo, no
   ampliarlo.
