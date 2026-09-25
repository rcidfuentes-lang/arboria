# Auditoría de uso de Arboria: dieciséis tareas reales en el navegador

**Arboria · 25 de septiembre de 2026**

Sobre `https://arboria.rubenstuff.es` en producción. El repositorio está en `main`,
commit de partida **`c49d69d`**. Producción **no** sirve ese commit: el bundle
desplegado es `assets/index-ClGLDDKF.js`, anterior a `c7339ef`, y todavía trae el
bug de la caché. Todo lo que se afirma aquí está medido en la página o leído en el
código, y cada cosa dice dónde vive.

---

## Lo que toqué y lo que no

**Songplay — Ecosistema: no se escribió nada.** Ni una fase, ni un estado, ni una
decisión. Antes de abrirlo comprobé en el bundle de producción que, con
`localStorage` vacío, `handleOpenProject` deja el estado en `synced` y no dispara
el autoguardado; con eso, abrirlo y navegarlo es solo lectura. Al terminar,
`updated_at` del proyecto sigue en `2026-09-25T10:09:50.734Z`, el mismo valor que
tenía al empezar, y `leer_nodo('SP4.1')` devuelve la rama idéntica: `SP4.1.1`,
`SP4.1.2` y `SP4.1.2.1`, sin renombrados ni cambios de estado.

**Lo que sí creé y borré.** Un proyecto **"Prueba de uso"**, copia de la
exportación de Songplay (143 nodos, 100.450 bytes), donde se hicieron todas las
tareas de escritura (3, 4, 5, 10, 11). **Está borrado.** Con él se fueron sus tres
decisiones de prueba y la fase `SP4.1.7` que creé dentro. En el listado queda un
solo proyecto.

**localStorage.** Al cerrar, el panel no tiene **ninguna** entrada
`arboria:roadmap-project:*`. La única que llegó a existir
(`arboria:roadmap-project:102274ed-…`) la borró el propio `handleDeleteProject` al
eliminar el proyecto de prueba; hice además una pasada explícita y no quedó nada.
La única clave que sigue ahí es la sesión de Supabase.

**Nada de código.** No se ha tocado ni un fichero del repositorio: `git status` de
Arboria sigue con los dos ficheros sin seguimiento que ya había, y Songplay sigue
en `d4be62e` con el árbol limpio. Esta pasada solo mide.

**Fuera de alcance por encargo:** la altura del textarea y la confirmación al
borrar un proyecto, ya arregladas y sin desplegar. Donde una medida quedaba
dominada por la altura del textarea, apliqué el arreglo de `main` en el navegador
(una regla CSS, no persistente) y remido; se dice en cada caso.

### Cómo se cuentan los números

Los **clics, teclas y scrolls son exactos**: los recogió un contador de eventos
instalado en la página. El **tiempo no es mi tiempo de reloj** —el mío incluye
pensar y escribir código, y no se parece al tuyo—, así que doy un **tiempo
modelado** con el modelo de nivel de pulsación: 1,1 s por apuntar-y-hacer clic,
0,28 s por tecla, 1,35 s por decisión. Va marcado como *modelado* siempre.

Donde digo "captura" doy además el **fragmento que reproduce el número en la
consola**, que es verificable y no se degrada. Las capturas de pantalla están en
la sesión; los números de aquí no dependen de ellas.

Una limitación honesta: en este navegador las pulsaciones sintéticas llegan a la
página pero no son de confianza, así que **Tab no mueve el foco**. La tarea 14 no
se pudo hacer tecleando; se resolvió calculando el orden de tabulación real desde
el DOM. Se explica allí.

---

## Las fricciones, por lo que estorban

### 1. Con el filtro puesto, "Subfase" crea una fase que no se ve y el foco cae en el ID del padre. Me renombró SP4.1 sin querer

**Tarea 4.** Es lo peor que encontré, y no lo encontré probando: me pasó haciendo
la tarea.

Secuencia, con filtro activo (que es como uno llega a una fase en un árbol de 143):

1. Filtro `SP4.1`, selecciono SP4.1, pulso **Subfase**.
2. La fase se crea —SP4.1 baja de 75% a 50%— pero **no aparece**: su id generado
   (`fase-mugtwq8l-4c215429`) no casa con el filtro, y `renderNode` corta en
   `if (!visibleIds.has(node.id)) return null`.
3. `addNode` hace `setSelectedId(nuevo)`, pero el efecto de búsqueda se vuelve a
   disparar al cambiar `flatNodes` y **devuelve la selección a la primera
   coincidencia**, que es el padre.
4. `setFocusIdNonce` enfoca el campo ID — que ahora muestra **`SP4.1`**, el id del
   padre.
5. Escribo el id que quería para la hija. Al hacer clic en cualquier otro sitio,
   `onBlur` dispara `commitSelectedId` y **el padre se renombra**.

Medido: el campo que recibió el foco contenía `SP4.1`. Después de teclear `.9` y
hacer clic fuera, el árbol mostraba **`SP4.1.9 Recorte de frontera`**. Y como
nada parecía pasar, pulsé Subfase otras dos veces: acabé con **tres fases
`Nueva fase` invisibles** colgando de SP4.1.

Lo que lo hace grave no es el renombrado en sí, es lo que arrastra: el id **es el
nombre público de la fase** —el que aparece en informes, en el conector y en las
conversaciones— y, como dice la fricción 3, **las decisiones que apuntaban a él se
quedan huérfanas en silencio**. En Songplay, SP1.7 tiene 25 decisiones colgando.

- **Dónde vive:** `src/components/RoadmapEditor.tsx:806` (el corte por
  `visibleIds`), `:774-783` (el efecto que roba la selección), `:427` (el foco),
  `:1120` y `:622` (el commit en blur).
- **Arreglo:** que el efecto de búsqueda no reseleccione si la selección cambió
  después de la última tecla —guardar el `query` que la provocó y no reaplicarla
  cuando el cambio viene de `flatNodes`—, y que `addNode` limpie el filtro.
  **Media tarde**, porque hay que pensar la condición para no romper el
  autoseleccionar-al-buscar, que sí es bueno.
- **Fallo**, sin ninguna duda. Tres decisiones razonables por separado que juntas
  se comen un dato.

### 2. El filtro del árbol esconde coincidencias, y no dice cuántas hay

**Tareas 1 y 4.** Buscar `SP4.1` devuelve **tres filas**: SP, SP4 y SP4.1.
`SP4.1.1` y `SP4.1.2` contienen literalmente `SP4.1` en su id y **son
coincidencias**, pero no salen. Si expando SP4.1 a mano, con el mismo filtro
puesto, aparecen las dos.

La causa: el árbol solo pinta hijos si el padre está en `expandedIds`, y el efecto
de búsqueda expande únicamente la ruta de la **primera** coincidencia. El lienzo
de Esquema no tiene este problema, porque `navigationNodes` hace
`if (isSearching) return true` e ignora el plegado.

Encima **no hay contador**. En el decisor sí lo hay ("77 a la vista · 177
escritas"), y ahí uno sabe si la lista está completa. En el árbol no hay forma de
saber que faltan dos.

- **Medido:** `SP4.1` → 3 filas de 5 coincidencias reales. Reproducible: poner el
  filtro y contar `document.querySelectorAll('.file-row').length`.
- **Dónde vive:** `src/components/RoadmapEditor.tsx:858` frente a `:403-410`.
- **Arreglo:** en `renderNode`, cuando hay búsqueda, pintar los hijos visibles sin
  mirar `expandedIds` —la misma regla que ya usa el lienzo—, y poner el contador.
  **Una línea** para lo primero, media hora con el contador.
- **Fallo.**

### 3. Renombrar una fase deja huérfanas sus decisiones, y el campo "Fase" no valida nada

**Tareas 6 y 10.** Dos mitades del mismo agujero:

- Creé la decisión 2 con **`SP99.99`** en "Fase del roadmap", una fase que no
  existe. Se guardó **sin un solo aviso**. El campo es texto libre
  (`SP1.3, si toca alguna. Opcional.`), no un selector, y no se contrasta contra
  el árbol.
- Renombré `SP4.1.3` → `SP4.1.7` en Editar. La decisión que apuntaba a ella
  **sigue diciendo `SP4.1.3`**. Nada avisa, ni en el roadmap ni en el decisor.

Las dos tablas están unidas por una cadena de texto sin integridad. Con la
fricción 1 encima, un renombrado accidental rompe el vínculo de todas las
decisiones de esa fase a la vez.

- **Dónde vive:** `commitSelectedId` (`src/components/RoadmapEditor.tsx:622`) solo
  toca el documento del roadmap; el decisor guarda `nodo_id` como texto y el
  formulario lo pinta en `src/components/Decisor.tsx` sin validar.
- **Arreglo:** al confirmar un id nuevo, buscar las decisiones con ese `nodo_id` y
  ofrecer actualizarlas; y en el formulario, marcar en ámbar una fase que no está
  en el árbol. **Media tarde.** Solo el aviso en el formulario, **una línea**.
- **Fallo** el renombrado silencioso. Lo de no validar puede ser a propósito —el
  decisor no debería depender de que el roadmap esté cargado—, pero entonces hace
  falta el aviso.

### 4. "Esquema" no sirve para ver de un vistazo: 2.350 × 22.654 px para enseñar 5 tarjetas de 143

**Tarea 7.** Cada nodo ocupa **su propia fila** en el lienzo
(`y: order * canvasRowGap`), sin que la profundidad la comparta. El resultado no
es un árbol: es una escalera diagonal.

| | Editar (árbol) | Esquema (lienzo) |
|---|---|---|
| Nodos a la vista | ~24 filas | **5 tarjetas** |
| Tamaño del lienzo | — | **2.350 × 22.654 px** |
| Scroll para recorrerlo | ~6 pantallas | **29 pantallas** verticales y 1,63 horizontales |

Filtrado a la rama SP4 (10 nodos) sigue midiendo 2.350 × 1.640 px y enseña 5.
Para la pregunta "qué está abierto, qué está cerrado y qué falta en SP4", Esquema
es **estrictamente peor** que el árbol, que es justo lo contrario de lo que
promete una vista de esquema.

- **Dónde vive:** `src/components/RoadmapEditor.tsx:139-140`, con las constantes
  en `:57-58` (`canvasColumnGap = 470`, `canvasRowGap = 158`).
- **Arreglo:** que `y` sea el orden **dentro del nivel** y no el orden global, que
  es lo que convierte la escalera en árbol. **Media tarde**, porque hay que
  recolocar también las líneas del SVG.
- **Decisión de diseño que no escala.** Con 15 nodos la escalera se lee; con 143
  no. Nadie decidió que fuera así a los 143.

### 5. 98 de los 143 títulos salen cortados, y no hay forma de leer el que se cortó

**Tarea 16.** A 1.440 px el panel del árbol mide **490 px** y recorta **98 de 143
filas (69%)**, con el árbol entero desplegado. Al peor, `SP1.9.6 Comentarios de
los tsconfig, numeración de las cuerdas y ruta de db-migrate`, le faltan **433 px**.

**Cuál de las dos reglas manda.** Hay dos en la hoja, y la primera auditoría citó
la que no se usa:

- `src/styles.css:437` — `.tree-layout { grid-template-columns: minmax(260px, 0.95fr) minmax(260px, 1fr) }`.
  **Es CSS muerto.** Ninguna clase `tree-layout`, `tree-panel` ni `node-form`
  aparece en el JSX, y `tree-layout` sale **0 veces** en el bundle de producción:
  es un resto de una maqueta anterior que sigue viajando en la hoja de estilos.
- `src/styles.css:971` — `.roadmap-body { grid-template-columns: minmax(320px, 34%) minmax(0, 1fr) }`.
  **Es la que manda.** `.roadmap-body` es el único contenedor que se renderiza
  (`src/components/RoadmapEditor.tsx:1078`), con `.file-tree` como panel
  (`:1079`). Medido en vivo: `gridTemplateColumns` = `489.594px 950.406px`.

Cuántos se cortan según el ancho del panel:

| Panel | 490 (hoy) | 600 | 700 | 800 | 900 | **923** |
|---|---|---|---|---|---|---|
| Cortados | **98** | 39 | 10 | 3 | 1 | **0** |

Para que **no se corte ninguno** hacen falta **923 px**, que en una ventana de
1.440 dejaría 517 para el editor: no es una opción. Para que **casi ninguno** se
corte bastan **700 px** (quedan 10) u **800 px** (quedan 3).

Lo que lo vuelve fricción y no estética: el botón de la fila **no tiene
`title`**, así que un título cortado **no se puede leer** sin seleccionar la fase;
y el panel tiene `resize: none`, así que no se puede ensanchar.

Los 143 son los del documento. Los 142 que cuentas son los descendientes, sin
contar la raíz SP.

- **Medido:** contando, por fila, el ancho del texto contra el ancho del `span`
  con `text-overflow: ellipsis`.
- **Dónde vive:** `src/styles.css:971` (el 34%), `:1086-1091` (la elipsis),
  `src/components/RoadmapEditor.tsx:823-826` (el botón sin `title`).
- **Arreglo:** añadir `title={node.title}` al botón, **una línea**, y resuelve el
  90% del dolor. Hacer el separador arrastrable, **media tarde**.
- **Fallo** lo del `title`. El ancho es una decisión razonable mal calibrada.

### 6. Desde un nodo no hay forma directa de ver sus decisiones, y buscar por id da 84% de ruido

**Tarea 6.** Se puede, pero no hay ningún camino hecho para ello. El editor del
roadmap **no sabe nada** del decisor salvo para montarlo: la única referencia en
todo `RoadmapEditor.tsx` es `<Decisor projectId=… />`.

El camino real son cuatro pasos: leer el id en pantalla, ir a **Decisiones**,
hacer clic en el buscador, teclear el id. Y el buscador hace `includes` sobre un
texto que junta `decidido + motivo + tema + detalle + nodo_id + norma + numero`,
así que el ruido depende de lo corto que sea el id:

| Se busca | Resultados | De ese nodo | Ruido |
|---|---|---|---|
| `SP4.1.2` | 1 | 1 | 0 |
| `SP4.1` | 4 | 3 | 1 |
| `SP1.7` | 26 | 25 | 1 |
| **`SP3`** | **77** | **12** | **65 (84%)** |

Verificado en pantalla: con `SP3` la cabecera dice "77 a la vista".

- **Dónde vive:** `src/components/Decisor.tsx:407-430`.
- **Arreglo:** un contador "N decisiones" junto a la fase seleccionada que lleve al
  decisor ya filtrado por `nodo_id` exacto. **Media tarde.** Solo un filtro de
  "fase exacta" en el decisor, **una línea** más el botón.
- **No es un fallo: es una función que falta.** Y es de las que más se notan,
  porque unir plan y decisiones es media razón de ser de Arboria.

### 7. El estado de una fase es un punto de 8 px de color, sin texto, sin tooltip y sin leyenda

**Tarea 7.** Para saber qué está abierto y qué cerrado en SP4 hay que descifrar
colores de memoria. El punto **no tiene `title` ni `aria-label`** —lo comprobé en
las nueve filas de la rama— y **no hay leyenda en ninguna pantalla**.

Los cinco colores: planificada `#9ca3af` gris, pendiente `#d3a72f` ámbar, en curso
`#2d7dd2` azul, bloqueada `#a23030` rojo, cerrada `#088c3f` verde
(`src/styles.css:1100-1118`).

El chip de porcentaje ayuda a medias y despista en un sitio: una hoja *en curso*
marca **50%**, así que `SP4.1.2.1`, que no tiene hijos, sale al 50% sin que haya
nada medio hecho. Es la convención de `nodeProgress`, pero leído del tirón parece
un dato.

- **Arreglo:** `title={etiquetaDeEstado}` en el punto. **Una línea.** La leyenda,
  media hora.
- **Decisión de diseño** —el punto mantiene la fila compacta, y eso es valioso con
  143 filas—, pero le falta la salida de emergencia.

### 8. La cadena de sustituciones no se puede seguir con un clic

**Tarea 12.** Al leer la 127 pone **"Inactiva. La sustituye la decision 124."**, y
ese "124" **es texto plano**: no hay ningún `<a>` ni botón en la página que lleve
a ella. Cada salto cuesta **2 clics y 3 teclas** (clic en el buscador, teclear el
número, clic en el resultado), ~4,4 s modelados.

La cadena 127 → 124 → 49 son dos saltos: **4 clics y 6 teclas**, reteniendo el
número de cabeza mientras tanto. Y el final de la cadena (la 49) no tiene
sustituta: su sitio lo ocupa `docs/gobierno/glosario.md`, que es exactamente la
regla de lectura de la casa, bien aplicada.

- **Dónde vive:** `src/components/Decisor.tsx:940-941`. El número ya está resuelto
  ahí (`numeroDe.get(actual.sustituida_por)`); solo falta que sea pulsable.
- **Arreglo:** convertir ese número en un botón que haga `setSeleccionada`.
  **Una línea.**
- **Fallo pequeño con efecto grande**, porque seguir cadenas es justo para lo que
  existe "el número es la identidad".

### 9. El uuid se escapa en "Lo que decía antes"

**Tarea 12.** En el historial de correcciones de la 127:

> Decision que la sustituye · 25 sept 2026, 7:14
> (vacio)
> **75c14bc4-9676-4343-98a4-ddfed67d782f**

El contexto del proyecto dice que "el uuid de la fila no sale nunca de la base".
Sale aquí. Y para el que lee, un uuid no dice nada: debería decir "124".

El código ya sabe traducir —`numeroDe.get(...)` se usa en las líneas 890 y 941—,
pero el historial pinta `fila.antes` y `fila.despues` en crudo.

- **Dónde vive:** `src/components/Decisor.tsx:1030-1031`.
- **Arreglo:** si `fila.campo === 'sustituida_por'`, pasar el valor por `numeroDe`.
  **Una línea.**
- **Fallo**, y además contradice una regla escrita del proyecto.

### 10. Los campos de una fase nueva vienen rellenos, con el cursor al final

**Tarea 4.** Al crear una subfase, el campo ID llega con **`fase-mugu6hn8-a1a30b68`**
(22 caracteres) y el cursor en la posición 22, **sin nada seleccionado**. El
Título llega con **`Nueva fase`** y lo mismo. Si tecleas, **se concatena**: lo
comprobé y salió `Nueva fasePrueba de auditoria`.

Así que antes de escribir hay que borrar **32 caracteres** entre los dos campos:
4 pulsaciones si sabes ⌘A, o **32 retrocesos** si no.

Coste completo de la tarea 4, camino limpio y sin filtro: **5 clics y 121
pulsaciones** (~40 s modelados), de las cuales 4 son solo para vaciar lo que la
aplicación puso. Choca con el principio de la casa de que **el id lo escribe
Rubén**: la máquina lo escribe primero y hay que quitarlo.

- **Dónde vive:** `createNode` y el foco en
  `src/components/RoadmapEditor.tsx:426-428`.
- **Arreglo:** `idInputRef.current?.select()` en lugar de `.focus()`, y lo mismo
  para el título al crear. **Una línea.**
- **Fallo pequeño**, de los que se pagan cada vez.

### 11. El árbol no es un árbol para el teclado: 481 tabulaciones hasta el panel de edición

**Tarea 14.** Aviso de método: en este navegador las teclas sintéticas llegan a la
página pero no son de confianza, así que **Tab no movía el foco** y no pude hacer
las tareas tecleando. Lo que sí pude es **calcular el orden de tabulación real**
desde el DOM, que es el mismo que recorrería el navegador.

Con el árbol de Songplay desplegado (144 filas):

| | Paradas de Tab |
|---|---|
| Hasta el buscador | 13 |
| Hasta la primera fila | 18 |
| Hasta la fila de SP4.1.2 | **291** |
| Hasta el campo ID, que es el primero del panel | **481** |
| Hasta el selector de Estado | 483 |
| Hasta el contenido | 484 |
| Total de la página | **484** |

La cifra que resume la tarea es **481**: es lo que cuesta llegar al panel de
edición. 483 y 484 son los dos campos siguientes, a una y dos tabulaciones más.

Cada fila del árbol son hasta **4 paradas** (plegar, nombre, copiar, menú). No hay
enlace de salto, no hay ningún `tabindex`, no hay `role="tree"` ni `treeitem`, y
**no hay navegación con flechas en ninguna parte**: en todo `RoadmapEditor.tsx` y
`Decisor.tsx` solo existen dos `onKeyDown`, el del campo ID y el del contenido.

- **Tarea 1 con teclado:** por el árbol, ~291 tabulaciones. Por el filtro, 13
  tabulaciones y 7 teclas — pero el foco **se queda en el buscador** y el nodo
  queda seleccionado a 460 paradas de distancia.
- **Tarea 3 con teclado:** 483 tabulaciones hasta Estado. Filtrando antes a 5
  filas, **45**. El filtro es la salida de emergencia del teclado, y funciona.
- **Tarea 8 con teclado:** la mejor de las tres. 6 tabulaciones al buscador,
  teclear `103`, y la lista se queda en un elemento: ~16 paradas en total.

Sobre el anillo de foco **no puedo concluir**: la hoja de estilos solo define foco
para `input`, `select` y `textarea` (`src/styles.css:102-105`) y no para `button`,
pero el anillo por defecto del navegador sí aparecería con un Tab de verdad, y
`:focus-visible` no se activa con un `.focus()` programático. Lo dejo como no
verificado en vez de afirmarlo.

- **Arreglo:** `role="tree"` con un solo punto de tabulación y flechas para
  moverse. **Más que media tarde**, es rehacer la navegación del árbol.
- **Fallo de accesibilidad**, aunque para un usuario único con ratón el coste real
  es bajo. Por eso está aquí abajo y no arriba.

### 12. A 375 px el cromo se come el 53% de la pantalla y el contenido queda en una rendija de 29 px

**Tarea 13.** Nada se rompe en ninguno de los cuatro anchos: **cero scroll
horizontal** de página y **cero elementos** que se salgan, en 1440, 1024, 768 y
375. Lo que cambia es cuánto sitio queda para trabajar.

Aviso sobre la fila de títulos cortados: son **las 22 filas que estaban a la vista**
en ese momento, las mismas en los cuatro anchos (solo cambié el ancho, no el
plegado), para que la comparación entre columnas sea válida. **No** son las 143 del
árbol entero: el **98/143 (69%)** de la fricción 5 se midió aparte, con todo
desplegado y a 1.440. Las 22 de esta tabla son sobre todo de primer y segundo
nivel, con poca sangría, así que se cortan menos que la media del árbol; por eso
9/22 (41%) aquí y 69% allí no se contradicen.

| | 1440 | 1024 | 768 | 375 |
|---|---|---|---|---|
| Panel del árbol | 490 px | 348 px | 768 (apilado) | 375 (apilado) |
| Cortados, de las 22 filas visibles | 9/22 | **20/22** | **0/22** | 19/22 |
| Caja de contenido | 79 px | 79 px | 64 px | **29 px** |
| Scroll horizontal | 0 | 0 | 0 | 0 |
| Botón más pequeño | 22 px | 22 px | 22 px | **22 px** |

Lo que pasa a cada ancho:

- **1024** es el peor para leer el árbol: el panel baja a 348 px y se cortan
  **20 de 22** títulos, porque el 34% encoge con la ventana pero los títulos no.
- **768** es, contra lo esperado, el **mejor** para el árbol: la maqueta se apila
  (`src/styles.css:2060-2063`, tree 42% / editor 58%), el panel ocupa el ancho
  entero y **no se corta ni un título**. A cambio el árbol solo enseña 8 filas.
- **375** no se rompe, pero no se puede trabajar: **~430 de 812 px (53%)** son
  cromo antes de que empiece el árbol —título, pestañas, "Guardado", una barra de
  herramientas que se parte en dos líneas y deja dos botones huérfanos en su
  propia fila, y la fila de Raíz/Buscar—; el árbol se queda con 5 filas y el
  contenido con **29 px**. El decisor sí se apila bien y se usa.
- **Los objetivos táctiles** miden 22 px (la flecha de plegar), la mitad de los 44
  recomendados, y son iguales en los cuatro anchos.

La caja de 29 px es en buena parte el bug del textarea, que ya está arreglado;
con el arreglo aplicado a 1440 la caja pasa de 79 a **630 px**. Lo que queda
propio de 375 es el cromo.

- **Arreglo:** a 375, colapsar la barra de herramientas en un menú. **Media
  tarde.** Lo de 1024 se arregla con un mínimo mayor en `minmax()`, **una línea**.
- **Decisión de diseño.** Arboria es una herramienta de escritorio y el teléfono
  no es su sitio; lo digo porque lo pediste, no porque haya que arreglarlo.

### 13. El menú ⋯ actúa sobre una fase distinta de la que estás editando

**Tarea 5.** Hay **dos nociones de "fase actual"** a la vez: la seleccionada, que
manda en el panel de la derecha, y aquella cuyo menú ⋯ está abierto. Abrir el menú
**no selecciona**. Así que se puede estar editando el contenido de SP4.1 y, tres
filas más abajo, borrar SP4.3 desde su menú, con el panel enseñando todavía SP4.1.

Lo vi en vivo: moví SP4.1.3 de padre desde su menú mientras el panel mostraba la
raíz SP.

- **Dónde vive:** `src/components/RoadmapEditor.tsx:831-833`.
- **Arreglo:** que abrir el menú seleccione la fila. **Una línea.**
- **Fallo pequeño**, más riesgo que molestia.

### 14. Una pestaña abierta se queda con una versión vieja del documento y no hay forma de refrescar

Observado durante la sesión, no en una tarea concreta. La pestaña que abrí al
empezar mostraba `SP4.1.2` **sin hijos** —con la flecha de plegar deshabilitada—
mientras la base ya tenía `SP4.1.2.1`. Solo recargando la página entera apareció.
Lo más probable es que la pestaña cargara justo antes de tu escritura de las
12:09:50, así que **no lo cuento como fallo**; lo cuento porque lo que lo hace
duradero sí es de la aplicación: **Arboria no vuelve a leer nunca**. No hay
refresco, no hay aviso de "esto ha cambiado fuera" y no hay botón de recargar.
Con el build viejo, además, esa copia vieja es la que el autoguardado puede subir
encima de la buena — que es el bug que ya tienes arreglado en `c7339ef`.

- **Arreglo:** releer al recuperar el foco de la ventana y comparar `updated_at`.
  **Media tarde**, y encaja con el trabajo de conflictos que ya está hecho.

---

## Las tareas, una a una

| # | Tarea | Clics | Teclas | Scroll | Modelado | Resultado |
|---|---|---|---|---|---|---|
| 1a | SP4.1.2 por el árbol | 5 | 0 | 0 | ~9,6 s | Sale. 3 despliegues. |
| 1b | SP4.1.2 por el filtro | **2** | 7 | 0 | ~5,5 s | Sale y **se autoselecciona**. |
| 2 | Leer SP1.3.5 entero | 1 | 0 | 8,5 pantallas | — | Ver abajo. |
| 3 | Cambiar estado | 4 | 5 | 0 | ~9 s | Instantáneo y correcto. |
| 4 | Alta de subfase | 5 | 121 | 0 | ~40 s | Fricciones 1 y 10. |
| 4b | Hermana en su sitio | 1 | 0 | 0 | ~1,1 s | Se puede. Ver abajo. |
| 5 | Mover / reordenar | 1–3 | 0 | 0 | ~4 s | Se puede, tres formas. |
| 6 | Decisiones de un nodo | 3 | 3–7 | 0 | ~6 s | Fricción 6. |
| 7 | SP4 de un vistazo | — | — | 29 pantallas | — | Fricciones 4 y 7. |
| 8 | Encontrar y leer la 103 | **3** | 3 | **0** | ~5,5 s | Cabe entera. |
| 9 | Activas sin norma | **2** | 0 | 0 | ~3,6 s | 55 de 177. |
| 10 | Decisión nueva | 7 | ~240 | 0 | ~75 s | Formulario limpio. |
| 11a | Retirar con norma | 6 | ~85 | 0 | ~30 s | Clarísimo después. |
| 11b | Retirar con sustituta | 5 | ~27 | 0 | ~15 s | Clarísimo después. |
| 12 | Seguir la cadena | 2/salto | 3/salto | 0 | ~4,4 s/salto | Fricción 8. |

**Tarea 2 (leer SP1.3.5, 1.794 caracteres en 9 párrafos).** En producción la caja
mide **79 px**: 3,2 líneas de 27, **8,5 pantallas de scroll**, con 541 px de fila
vacía debajo. Ese es el bug ya arreglado. **Con el arreglo de `main` aplicado**, la
caja pasa a **630 px**: 25,4 líneas de 27,1, **1,07 pantallas**. Cabe
prácticamente entera y se lee bien. Lo que queda después del arreglo es menor: la
línea mide **95 caracteres** en monoespaciada, por encima de lo cómodo, y el
párrafo más largo (625 caracteres) ocupa siete líneas seguidas sin respiro. De los
143 nodos, 40 pasan de 600 caracteres y 13 de 1.000; el mayor, SP1.8 con 2.935,
pediría ~1,4 pantallas incluso arreglado. **No hay ningún nodo que use Markdown**
—ni negritas, ni listas, ni enlaces, en los 143— así que el `placeholder`
"Markdown de la fase" promete algo que nadie usa. Un detalle con más peso: leer y
editar son **el mismo modo**, así que no hay forma de leer una fase sin estar
dentro de un campo editable.

**Tarea 4b (hermana entre dos existentes).** Sí se puede elegir la posición: la
hermana cae **justo detrás de la seleccionada** (`addNode(padre, index + 1)`,
`src/components/RoadmapEditor.tsx:1108`). Verificado: con SP4.1.1 seleccionada, la
nueva quedó entre SP4.1.1 y SP4.1.2. Cuesta **1 clic**. Pero es una convención que
hay que adivinar: el botón dice "Hermana" y nada indica dónde va a caer. Y no hay
forma directa de poner una **antes de la primera**; hay que crearla y subirla.

**Tarea 5 (mover y reordenar).** Se puede, de tres formas:

- **Reordenar:** "Mover arriba" / "Mover abajo" en el menú ⋯. El menú **se queda
  abierto**, así que mover varias posiciones cuesta **1 clic cada una**. Bien
  resuelto.
- **Cambiar de rama:** "Cambiar padre" en el mismo menú. Verificado: SP4.1.3 pasó
  de SP4.1 a SP4.2. El pero es el selector: **144 opciones** en un desplegable
  dentro de un menú emergente, etiquetadas `SP0 — Herencia — de dónde venimos`. Y
  cae siempre **al final** de los hijos del nuevo padre (`insertNode` sin índice,
  `src/components/RoadmapEditor.tsx:684`), sin poder elegir.
- **Arrastrar:** existe, pero **solo en Esquema**, con zonas "Antes" / "Despues",
  soltar como hijo y una franja de "Soltar aqui para separar como raiz". Está
  hecho con HTML5 (`draggable` + `onDragStart`/`onDrop`,
  `src/components/RoadmapEditor.tsx:883-914`). **No lo ejercité**: este navegador
  no sintetiza ese gesto de forma fiable. Lo digo porque no lo he comprobado, no
  porque falle. Lo que sí es medible es que la única vista con arrastre es la que
  mide 29 pantallas.

**Tarea 7 (SP4 de un vistazo).** La verdad del documento: SP4 tiene 9 nodos —4 en
curso, 4 planificadas, 1 cerrada—. En **Editar** se llega, pero descifrando nueve
puntos de color (fricción 7) y con los títulos cortados (fricción 5). En
**Esquema** no se llega (fricción 4). Ninguna de las dos contesta "qué falta" sin
contar a mano.

**Tarea 15. Los botones de solo icono.** Conté **11** en el cromo, no diez: **6**
en la barra de arriba, **3** en la del árbol y **2** en la fila de acciones de la
fase. Son 9 funciones distintas, porque **"Unir otro proyecto" aparece tres veces
con el mismo icono** en tres sitios. Todos tienen `title` y `aria-label`, así que
el ratón los resuelve; la columna que importa es la primera.

| Icono | Qué esperaba antes de pasar el ratón | Qué hace | ¿Acierto? |
|---|---|---|---|
| `gitMerge` ⑂ | Una rama, un diagrama, algo de git | **Unir otro proyecto** | No |
| `download` ↓ | Descargar | **Exportar proyecto** | Sí |
| `fileBranch` | Ver la rama, un diagrama | **Exportar rama** | No: es otra descarga, y su icono no se parece al de al lado |
| `printer` 🖨 | Imprimir | **Imprimir** | Sí |
| `folderOpen` 📂 | Abrir un fichero | **Volver a proyectos** | No: parece que abre, y en realidad sale |
| `logOut` →\| | Salir | **Cerrar sesión** | Sí — pero está **pegado** al de volver, y uno sale del proyecto y el otro de la cuenta |
| `maximize` ⛶ | Pantalla completa | **Expandir todo** | No |
| `minimize` ⊹ | Salir de pantalla completa | **Contraer todo** | No |
| `gitMerge` ⑂ (2ª) | Lo mismo que el primero | Lo mismo | Repetido |
| `gitMerge` ⑂ (3ª) | Lo mismo | Lo mismo | Repetido |
| `check` ✓ | Aceptar, confirmar | **Cerrar fase** (pone el estado en cerrada) | No: parece "guardar" y **escribe en el documento** |

Los dos que más me inquietan: **`folderOpen` junto a `logOut`**, donde confundirse
cuesta la sesión; y **`check`**, que en cualquier formulario significa "aceptar" y
aquí cambia el estado de la fase. Los dos de pantalla completa (`maximize` /
`minimize`) para expandir y contraer son el desajuste más común, aunque el más
inofensivo.

- **Arreglo:** cambiar tres iconos (`folderOpen` → flecha atrás, `check` →
  candado o bandera, `maximize`/`minimize` → los de árbol) y separar el de cerrar
  sesión. **Media tarde.**
- **Decisión de diseño** con una excepción: el `check` que escribe sin decir que
  escribe está cerca de ser un fallo.

---

## Lo que funciona bien y no hay que tocar

- **El indicador de guardado dice la verdad.** Muestreando cada 50 ms tras un
  cambio: 55 ms → **"Guardado localmente"** en ámbar, 924 ms → "Guardando",
  1.434 ms → "Guardado" en verde. No hay ninguna ventana en la que diga que está
  guardado sin estarlo. Lo comprobé porque sospechaba lo contrario, y me
  equivocaba: está bien hecho.
- **El progreso se propaga al instante.** Cerré SP4.2 y en el mismo fotograma SP4
  pasó de 15% a 35% y el proyecto de 32% a 33%, sin recargar nada. La tarea 3 no
  tiene ninguna fricción.
- **El filtro del decisor es el buen modelo.** Contador "N a la vista · 177
  escritas, 55 activas, 105 en una norma"; busca por número, por nodo, por norma y
  por texto a la vez; y los dos grupos de filtros se cruzan en vez de pisarse.
  Esto es exactamente lo que le falta al filtro del árbol.
- **"Activas" + "Sin norma" en 2 clics** contesta *qué queda por escribir*: **55**
  de 177, y resulta que **ninguna** activa tiene norma todavía. Tres segundos para
  una pregunta de gobierno. Es de lo mejor que hay en la aplicación.
- **El autoseleccionar al filtrar en el árbol** (`RoadmapEditor.tsx:774-783`)
  ahorra un clic entero y hace que la tarea 1 por filtro cueste 2 clics en vez de
  3. Es buena idea; lo que hay que arreglar es que se vuelva a disparar cuando no
  toca (fricción 1), no la idea.
- **La retirada de una decisión está muy bien resuelta.** El modal dice "Todo se
  hace de una vez: si algo falla no se escribe nada", ofrece los tres caminos
  —escribir una nueva, elegir una existente, apuntar a una norma— y al escribir
  una nueva deja empezar desde el texto de la vieja. Al leerla después **queda
  perfectamente claro qué ocupa su sitio**, en los dos casos que probé:
  - *"Inactiva. La recoge docs/gobierno/auditorias.md §3.1."*
  - *"Inactiva. La sustituye la decision 3."*

  Y la lista marca `inactiva` / `en norma`. La regla de lectura de la casa —si hay
  sustituta eso ocupa su sitio, si no la norma— se lee sola en la pantalla. La
  respuesta a la tarea 11 es que sí, queda clarísimo.
- **El formulario de decisión nueva** cabe entero en una pantalla, llega con
  **todos los campos vacíos** (al revés que el de fase), con la fecha de hoy
  puesta y con marcadores que explican qué va en cada sitio. 
- **Reordenar con el menú abierto:** 1 clic por posición, sin reabrir nada.
- **El documento sale igual por todas las puertas.** La exportación del botón
  midió **100.465 bytes** y `leer_roadmap` del conector devolvió **100.465
  caracteres**, con los mismos 143 nodos. Lo comprobé sin querer y salió exacto.
- **Nada se rompe a ningún ancho.** Cero scroll horizontal y cero elementos
  desbordados en 1440, 1024, 768 y 375.
- **El árbol no pierde el hilo:** plegar, desplegar y seleccionar no escriben nada
  en el documento, así que navegar un proyecto ajeno es seguro. Es lo que permitió
  hacer media auditoría sobre Songplay sin tocarlo.

---

## Lo que no está en esta lista

El alcance lo eliges tú, así que aquí no hay recomendación de qué hacer. Dos
apuntes para cuando lo decidas:

- Las fricciones **1, 2, 3, 8, 9, 10 y 13** son de **una línea o poco más** cada
  una salvo la 1 y la 3. Las fricciones **4, 6, 11 y 12** son trabajo de verdad.
- La fricción **1** es la única que **pierde datos**. Si solo se toca una cosa,
  yo tocaría esa; y su mitad barata —que `addNode` limpie el filtro— ya rompe la
  cadena.
