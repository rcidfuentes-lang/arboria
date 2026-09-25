# Auditoría de Arboria: velocidad, uso y seguridad

**Arboria · 25 de septiembre de 2026**

Sobre `https://arboria.rubenstuff.es` en producción y sobre el código de este
repositorio en `main`, commit `ae8f2c6`. Todo lo que aquí se afirma está medido
o leído en el código, y cada cosa dice dónde vive.

Dos avisos antes de empezar, porque son cosas que toqué yo:

- Para medir el coste de teclear escribí **cinco caracteres** en el contenido
  del nodo SP0.4 del roadmap de Songplay y los retiré acto seguido. El campo
  volvió a sus 1.060 caracteres, con el mismo final, y la pantalla marcó
  "Guardado". No queda rastro en el texto, pero sí dos escrituras en el
  historial de `updated_at`.
- Para comprobar si el registro dinámico de clientes es realmente público,
  **di de alta un cliente de prueba**. Está en `mcp_oauth_clients` con el
  nombre "Prueba de auditoria" y el `client_id`
  `2c0c7a76-df53-4da5-b014-3dd12a299041`. No concede acceso a nada —un cliente
  registrado solo puede *pedir* permiso— pero conviene borrar la fila.

---

## Lo primero, porque es lo que hay que arreglar hoy

### 1. Hay un XSS almacenado en la vista de impresión

`markdownToHtml` (`src/components/RoadmapEditor.tsx:296`) construye HTML
pegando cadenas:

```js
return `<p>${line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</p>`
```

Y lo que entra en esa función es el `id`, el `title` y el `content` de cada
nodo, sin escapar nada. El resultado se inyecta tal cual:

```jsx
<section className="print-surface" dangerouslySetInnerHTML={{ __html: printHtml }} />
```

`src/components/RoadmapEditor.tsx:1232`.

Reproducido con una copia literal de la función: un nodo titulado
`<img src=x onerror="...">` sale del conversor con la etiqueta intacta, y
`dangerouslySetInnerHTML` sí ejecuta los manejadores `onerror` y `onload`.

**Por dónde entra.** Arboria tiene cuatro puertas de importación de JSON, y
ninguna sanea el contenido: "Importar JSON", "Importar como subfases",
"Reemplazar esta rama" y "Unir otro proyecto". Basta con que Rubén pegue un
roadmap que le haya pasado otra persona —o que se lo devuelva una herramienta—
y abra "Imprimir".

**Qué se lleva.** El código corre en el origen de Arboria, y ahí, en
`localStorage`, está la sesión de Supabase (`sb-kmlurbgkyssdowfapdiz-auth-token`:
lo verifiqué en el navegador). Con ese token se leen, se escriben y se borran
todos los roadmaps, se dan de alta claves de lectura y se autorizan conectores.
Es la cuenta entera.

**El arreglo está escrito ya, en este mismo repositorio.**
`sanitizeRichText` (`src/lib/roadmap-document.ts:174`) hace exactamente lo que
hace falta: parsea, recorre, deja pasar solo las etiquetas de una lista blanca
y quita todos los atributos. O más simple todavía: escapar `&<>"` antes de
interpolar, que en un conversor de Markdown es lo correcto de todas formas
—hoy un guion bajo del texto ya puede romper el HTML sin que nadie ataque nada.

### 2. Borrar un proyecto no pregunta

`src/components/ProjectList.tsx:413`. Un clic en la papelera llama a
`handleDeleteProject` y la fila se va. Con ella se van, en cascada, sus claves
de lectura (`roadmap_api_keys`), sus decisiones y el historial de esas
decisiones. No hay confirmación, no hay deshacer y no hay papelera.

Lo que lo hace más agudo es que el botón está pegado al de abrir el proyecto y
al de descargarlo, los tres en la misma fila, y que Arboria **sí pregunta para
lo pequeño**: borrar una fase abre un `window.confirm`
(`src/components/RoadmapEditor.tsx:651`). Pregunta por una rama y no pregunta
por el árbol.

### 3. La copia local puede pisar la del servidor, sin avisar

`handleOpenProject` (`src/components/ProjectList.tsx:209`) prefiere el
documento que haya en `localStorage` sobre el que acaba de traerse de la base, y
cuando lo usa deja el estado en `'local'`. Ese estado es justo el que dispara el
autoguardado 900 ms después (`src/components/ProjectList.tsx:255`).

Encadenado: abrir un proyecto en un navegador que guarda una copia vieja
—porque una sincronización falló, porque se editó en otro sitio, porque la
pestaña se cerró a medias— **sube esa copia vieja encima de la buena**. Y el
`update` va con `.eq('id', ...)` a secas, sin comparar `updated_at`, así que
gana siempre el último que escriba y nadie se entera de que ha perdido algo.

Lo mínimo: comparar `updated_at` antes de escribir y, si no casa, decirlo en
pantalla en vez de resolverlo por silencio.

---

## Velocidad

Lo primero que hay que decir es que **el render de Arboria es rápido**, y eso no
me lo esperaba en una pantalla con 141 nodos y 176 decisiones. Filtrar el árbol
cuesta entre 2 y 5 ms por tecla; buscar en el decisor, entre 1 y 14 ms. El
`PerformanceObserver` no registró **ni una sola tarea larga** en toda la
sesión. React aquí no es el problema.

La carga inicial también está bien, aunque los números hay que leerlos con
cuidado. En la primera medición salieron TTFB 445 ms, `load` 533 ms y primer
pintado 712 ms, y ese orden —`load` **antes** del primer pixel— parece un
error y no lo es: el HTML que sirve Netlify son **458 bytes** con un
`<div id="root">` vacío. El evento `load` se dispara sobre una página en
blanco, y lo primero que se ve no aparece hasta que React ha montado. En una
aplicación así `load` no mide nada que el usuario vea; el número que cuenta es
el del primer pintado.

Y repitiendo la medición varias veces, ninguno de los tres es estable: el TTFB
fue de 157 a 857 ms y el `load`, de 215 a 1.513 ms, según la caché del borde de
Netlify. Tómense como un orden de magnitud —décimas de segundo, no segundos— y
no como una marca. Sin errores en la consola en ninguna de las pasadas.

Lo que pesa es la red, y son cuatro cosas concretas.

### El logo son 781 KB y se pide dos veces

`dist/arboria-logo.png`: 1254 × 1254, 799.410 bytes. Es el favicon
(`index.html:5`) **y** la marca de la cabecera, así que en la primera visita se
descarga dos veces: cerca de 1,6 MB para dibujar un icono de 16 px y un sello de
unos 40. El resto de la página junta 125 KB de JavaScript y 5 KB de CSS, ambos
comprimidos. O sea: el logo es el 85% del peso de Arboria.

Un favicon de 32 px y una versión de unos 120 px para la cabecera dejan esto en
unos pocos kilobytes, y es media tarde de trabajo.

### La lista de proyectos se trae los roadmaps enteros para pintar un nombre

`src/components/ProjectList.tsx:103`:

```js
.from('roadmap_projects').select('*')
```

`*` incluye la columna `document`, que es el roadmap completo en `jsonb`. Y todo
eso para pintar el nombre del proyecto y su fecha.

Medido contra la base, con un solo proyecto:

| consulta | tamaño |
|---|---|
| `select=*` | **83 KB** |
| `select=id,name,slug,updated_at` | **menos de 1 KB** |

Hoy hay un proyecto y no se nota. Con diez roadmaps de este tamaño son 830 KB
antes de que aparezca la primera línea de la lista.

### Cada guardado sube y baja el documento completo

El autoguardado (`src/components/ProjectList.tsx:259`) manda el `document`
entero y encima pide `.select('*').single()`, así que los mismos 83 KB vuelven.
Cambiar una letra del título reescribe el `jsonb` completo, en las dos
direcciones.

Las dos escrituras que provoqué al medir tardaron **512 ms** y **6.337 ms**.
Seis segundos y pico para cinco caracteres. La interfaz lo aguanta bien —marca
"Guardando" y no se bloquea— pero es una ventana muy ancha para que algo salga
mal, y explica por qué el punto 3 de arriba importa.

### Los ficheros con hash en el nombre no se cachean

```
cache-control: public,max-age=0,must-revalidate
```

Esa es la cabecera que sirve Netlify para `/assets/index-ClGLDDKF.js` y para el
logo. Pero ese nombre **ya lleva el hash del contenido**: si el fichero cambia,
cambia el nombre. Revalidarlo en cada visita es pagar un viaje de ida y vuelta
por nada.

En `netlify.toml`, que es donde ya vive todo lo demás de la configuración:

```toml
[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
```

---

## Seguridad

### Lo que está bien, que es mucho y conviene dejarlo dicho

La base de datos está hecha con cuidado, y no es una cortesía decirlo: es lo que
hace que el resto de esta sección sea corta.

- **RLS en todas las tablas**, y las políticas de `update` llevan `using` **y**
  `with check`, que es lo que impide mover una fila al proyecto de otro.
- **Todas las funciones `security definer` con `set search_path = ''`** y cada
  identificador cualificado con `pg_catalog`. Es la forma dura de escribirlas y
  está hecha en las nueve migraciones, sin una sola excepción.
- **Ninguna credencial se guarda en claro**: ni las claves de lectura, ni los
  códigos de autorización, ni los tokens. Solo su SHA-256. Una copia de esas
  tablas no abre ningún roadmap.
- **PKCE S256 obligatorio, y comprobado dentro de la base**, no en el endpoint.
  El comentario de `20260920120000_create_mcp_oauth.sql:268` explica por qué, y
  la razón es correcta: si comparase el endpoint, cualquiera podría saltárselo
  llamando a la RPC directamente.
- **Rotación de refresh tokens con detección de reutilización**: presentar uno
  ya rotado revoca la cadena entera.
- **Un solo `invalid_grant`** para los ocho motivos posibles de fallo. No se le
  cuenta al que prueba por dónde va bien.
- **La clave del navegador es `sb_publishable_…`**, la nueva, no un JWT `anon`
  heredado. Y las funciones de Netlify llaman con esa misma clave, nunca con la
  de servicio (`netlify/lib/supabase-rpc.ts`, y el comentario de arriba dice
  exactamente por qué).
- **La redirección se valida antes de redirigir** en la pantalla de
  autorización, que es la defensa contra el enlace preparado.
- RFC 8707 (`resource`) y RFC 9207 (`iss`) implementados, los dos.
- Sin secretos versionados: `git ls-files` solo devuelve `.env.example`, vacío.

Y comprobado en vivo: `/api/roadmap`, `/api/decisiones` y `/mcp` responden
**401** sin credencial y con credencial falsa, y `/mcp` devuelve el
`WWW-Authenticate` con el `resource_metadata` que manda la especificación.

### La pantalla de autorización se puede meter en un iframe

No hay `X-Frame-Options` ni CSP con `frame-ancestors`. Lo único que sirve
Netlify en el HTML es `strict-transport-security`, y sin `includeSubDomains` ni
`preload`.

Y el registro de clientes es público. Lo comprobé: un `POST` a `/oauth/registro`
sin ninguna credencial devolvió un `client_id` y un 201.

Las dos cosas juntas son una cadena: registrar un cliente con una redirección
propia, montar una página que meta `/oauth/autorizar?client_id=…` en un iframe
transparente, y conseguir que Rubén pulse donde está el botón de conceder. Sale
con permiso de lectura sobre el roadmap que estuviera elegido.

Que el registro sea público es correcto y está bien razonado en el comentario de
`netlify/functions/oauth-registro.mts` —el cliente todavía no tiene con qué
autenticarse—. Lo que falta es la otra mitad: que la pantalla donde se concede
el permiso no se pueda enmarcar.

### Faltan las cabeceras de seguridad

Además de `frame-ancestors`, no hay `Content-Security-Policy`, ni
`X-Content-Type-Options`, ni `Referrer-Policy`, ni `Permissions-Policy`. Las
funciones sí salen con `nosniff` —lo pone Netlify— pero el HTML no.

Una CSP mínima habría contenido el XSS del punto 1: sin `unsafe-inline` en
`script-src`, el `onerror` de un `<img>` no corre. Es la diferencia entre un
fallo y un fallo explotable.

```toml
[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
```

La CSP pide más cuidado, porque hay que dejar pasar a Supabase y comprobar que
Vite no necesita estilos en línea. Pero las cuatro de arriba no rompen nada.

### No hay forma de revocar nada desde la aplicación

Arboria concede permisos por pantalla —la clave de lectura por script, el
conector MCP en `/oauth/autorizar`— pero **no los enseña ni los retira por
pantalla**. No hay una lista de claves activas, ni de conectores autorizados, ni
un botón de revocar. Buscando en `src/` no aparece ninguna consulta a
`roadmap_api_keys` ni a `mcp_oauth_tokens`.

El modelo es bueno: las columnas `revoked_at` existen y las funciones de lectura
las respetan. Lo que falta es la mano. Hoy, si un token se filtra, cortarlo
exige entrar a Supabase Studio y escribir SQL, y saber cuál de las filas es.

Para una herramienta que va a repartir claves a Songplay y conectores a
claude.ai, esta es la pieza que más se va a echar de menos según crezca.

### Dos cosas menores

- **El tope de altas es global.** `mcp_register_client` corta a las 20
  inscripciones por hora contando *todas* las filas
  (`20260920120000_create_mcp_oauth.sql:149`), no por cliente ni por origen. Con
  veinte peticiones cualquiera deja a Rubén sin poder dar de alta un conector
  durante una hora. No se llevan nada; solo estorban.
- **Falta un `revoke` por simetría.** `decisiones` retira explícitamente los
  permisos de `anon` sobre la tabla. `roadmap_projects` y `roadmap_api_keys` no
  lo hacen. No es un agujero —sin política, `anon` no ve ninguna fila— pero el
  propio repositorio explica en `20260920170000_create_decisiones.sql:300` por
  qué conviene decirlo dos veces, y ahí solo se dijo una.

---

## Uso y aspecto

### Lo que está bien

Conviene decirlo antes de la lista de peros, porque es trabajo hecho y no se ve:

- **El contraste pasa AA en todo lo que medí.** Lo más justo es la etiqueta de
  campo, 4,62:1, y el resto va de 6:1 a 13:1.
- **Todos los botones tienen nombre accesible.** Los recorrí en el árbol de
  accesibilidad: ni uno solo sin `aria-label` o sin texto, y son unos treinta,
  casi todos de icono. Es raro encontrarse esto.
- **Todos los campos tienen etiqueta**, ninguno colgando de un `placeholder`.
- **No se pisa el anillo de foco**: no hay ningún `outline: none` en las 2.115
  líneas de CSS.
- La vista de **Esquema** está bien dibujada, con conectores curvos y jerarquía
  legible de un vistazo.
- El decisor resume con honestidad —"176 escritas, 54 activas, 105 en una
  norma"— y filtra por lo que de verdad se pregunta.

### El campo de escribir mide 79 píxeles y su texto pide 374

Es el hallazgo de uso más rentable de todo el informe, porque es una línea de
CSS.

Medido en vivo sobre el nodo SP0.4: el `textarea` de contenido renderiza a
**79 px** de alto, su contenido necesita **374**, y `resize` está en `none`, así
que no se puede agrandar a mano. La rejilla que lo contiene **le tiene
reservados 460 px** —la última fila de `.text-editor` mide 460,67 px— y se
quedan vacíos.

La causa está en `src/styles.css:1409`, y no es la que parecía de primeras:

```css
.text-editor {
  grid-template-rows: auto auto auto auto minmax(0, 1fr);  /* cinco filas */
  align-items: start;
}
```

**Sobra una fila.** `.text-editor` tiene cuatro hijos —el progreso, los
botones, los campos y el `textarea`— y la plantilla declara cinco pistas. Los
cuatro caen en las cuatro primeras, que son todas `auto`, y la quinta, la de
`minmax(0, 1fr)`, se queda vacía quedándose con los 460 px. El `textarea`
aterriza en una fila que se encoge hasta su contenido, y su contenido, con
`rows` a 2, son 79 px.

`.content-editor` **ya tiene `align-self: stretch`** (`src/styles.css:1509`),
puesto y correcto desde siempre; lo que pasa es que estirarse dentro de una
fila `auto` no lleva a ninguna parte. Por eso el arreglo no es tocar la
alineación sino quitar la pista que sobra:

```css
  grid-template-rows: auto auto auto minmax(0, 1fr);
```

Comprobado en vivo inyectando esa regla sobre la página desplegada: el
`textarea` pasa de **79 px a 550 px** y la fila vacía desaparece. La superficie
principal de escritura de Arboria pasa de tres líneas a más de veinte.

### El árbol corta los títulos a media palabra

"Herencia — de dónd…", "Genealogía del …", "La Forja — cerr…", "Sala de
Despiec…". El panel del árbol está topado en `minmax(260px, 0.95fr)`
(`src/styles.css:437`) mientras el de detalle tiene aire de sobra —los campos de
ID, Título y Estado caben en una fila y sobran doscientos píxeles a la derecha.

Los identificadores (SP0.1, SP1.1.1) ayudan, pero el título es lo que se lee
para navegar, y se lee a la mitad. Un panel redimensionable, o sencillamente más
ancho, devuelve la frase.

### Entre 470 y 800 píxeles el árbol se queda en un visor de cinco filas

En ese tramo de anchuras la barra de herramientas se apila y ocupa más de la
mitad del alto, y el árbol queda reducido a una ventana de unas cinco filas para
141 nodos. Funciona, pero navegar así es tedioso. En móvil de verdad (375 px) se
apila entero y se comporta mejor que en la tableta.

### No hay recuperación de contraseña

La pantalla de acceso (`src/components/Login.tsx`) es correo y contraseña, y
nada más: ni "he olvidado la contraseña", ni verificación en dos pasos, ni aviso
de sesión iniciada. Olvidar la contraseña hoy significa entrar a Supabase.
`supabase.auth.resetPasswordForEmail` es un enlace y un formulario.

### Detalles de aspecto

- **`<html lang="en">`** (`index.html:2`) en una aplicación escrita entera en
  español. Un lector de pantalla la leerá con voz inglesa. Es una palabra.
- **La píldora de progreso repite "100%"** en casi todas las filas del árbol:
  mucha tinta repetida para poca información. Dibujar solo lo que *no* está
  cerrado haría que el ojo fuera directo a lo que queda por hacer, que es para
  lo que se mira un roadmap.
- **El porcentaje del proyecto sale dos veces**: en la barra superior y en el
  panel de detalle, a un palmo uno del otro.
- **Se declara `Inter` y no se carga.** `src/styles.css:18` la pone la primera
  de la lista, pero no hay `@font-face` ni enlace a ninguna fuente. Quien no la
  tenga instalada ve la tipografía del sistema, que no es aquella para la que
  está dibujada esta interfaz.
- **En Esquema no hay ajustar a pantalla ni zoom.** Con cuatro niveles de
  profundidad y 141 nodos, el lienzo se hace muy largo y solo queda recorrerlo.
  "Expandir todo" y "Contraer todo" existen en Editar, pero no ahí.
- **Diez botones de solo icono en la barra superior.** Tienen `title` y
  `aria-label`, así que el hover y el lector de pantalla los resuelven, pero la
  primera vez hay que ir probándolos uno a uno.

---

## Por dónde empezar

Ordenado por lo que cuesta arreglarlo contra lo que evita:

1. **Escapar el HTML de la vista de impresión.** Una función de escape, o
   reutilizar `sanitizeRichText`. Cierra la toma de cuenta.
2. **Preguntar antes de borrar un proyecto.** Un `window.confirm`, como el que
   ya hay para las fases.
3. **Quitar la fila que sobra en `.text-editor`.** Una línea, y la
   pantalla principal cambia de carácter.
4. **`lang="es"`.** Una palabra.
5. **Las cuatro cabeceras de `netlify.toml`** y el `Cache-Control` de
   `/assets/*`. Un bloque de configuración, sin tocar código.
6. **Reducir el logo** y separar favicon de marca. El 85% del peso de la página.
7. **`select` con columnas en la lista de proyectos.** De 83 KB a menos de 1 KB
   por proyecto.
8. **Comparar `updated_at` al guardar** y no dejar que la caché local pise la
   copia buena sin decirlo.
9. **La pantalla de claves y conectores**, con su botón de revocar. Es la más
   larga de todas y la que más falta va a hacer.

Lo que hay debajo de todo esto —la base, el OAuth, las políticas— está bien
hecho y no hay que tocarlo. Lo que falla está casi todo en la capa de encima, y
casi todo es corto.
