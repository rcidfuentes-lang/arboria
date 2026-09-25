# Inactivar una decisión apuntando a una norma

**Arboria · 25 de septiembre de 2026**

Material para el acta del nodo SP3.14.1, que vive en el roadmap de Songplay.
Este informe es de Arboria y no lleva cabecera de norma, porque Arboria no
tiene protocolo documental.

---

## Qué se ha cambiado, y por qué

Una decisión solo se podía retirar apuntando a **otra decisión**, porque el
campo de sustitución era el identificador de una fila de la misma tabla. Eso
dejaba sin salida el caso que importa hoy en Songplay: de las 168 decisiones
activas, 103 repiten lo que ya dice una norma del repositorio. La decisión
sigue siendo verdad, pero ya no vive en el decisor: vive escrita en un
documento. Sin poder señalar ese documento, no se podía cumplir la regla del
proyecto —decir por qué se quita una decisión y qué la sustituye— y la limpieza
no se podía hacer.

Ahora una decisión puede declarar **qué norma la recoge**: el documento y, si
hace falta afinar, su apartado. `docs/SP3-canon.md`, `§7.5`.

**Es un solo campo, no dos.** "Inactivar apuntando a una norma" y "declarar qué
norma recoge esta decisión sin retirarla" son el mismo dato: esta decisión está
escrita en tal sitio. Lo que cambia es si además se retira. Por eso la norma
vive en la decisión y no dentro del bloque de inactivación, y vale igual estando
activa que estando inactiva.

La regla de lectura, entera:

> Si hay `sustituida_por`, eso es lo que ocupa su sitio. Si no lo hay, lo ocupa
> la norma.

Las dos cosas a la vez no son una contradicción: es una decisión que estaba
escrita en el canon y que además reemplazó otra decisión posterior.

### La base

`supabase/migrations/20260925120000_decision_recogida_en_norma.sql`.

- Dos columnas en `decisiones`: `norma_documento` y `norma_apartado`. Nacen
  nulas y sin valor por defecto, así que la tabla no se reescribe.
- Un apartado **no puede ir sin documento**: `§7.5` a secas no se puede leer.
- La restricción de la inactivación se relaja: una inactiva exige motivo y
  `(sustituida_por o norma_documento)`. Relajar un check no invalida ninguna
  fila escrita, así que las 173 decisiones pasan tal cual.
- El disparador del rastro registra los dos campos nuevos. Cambiar la norma deja
  dicho lo que decía antes, como cualquier corrección.
- `decisiones_de_proyecto` añade una clave `norma` por decisión.
- `inactivar_decision` admite una tercera forma. Se borra y se recrea con un
  parámetro más, porque añadir un parámetro cambia la firma y `create or
  replace` habría dejado dos funciones vivas y las llamadas ambiguas. Lo que
  esté desplegado mientras tanto no se rompe: PostgREST llama por nombre de
  argumento y el parámetro nuevo lleva valor por defecto.
- `importar_decisiones` escribe la norma, y admite la baja por norma.

### La lectura: `/api/decisiones` y `leer_decisiones`

Cada decisión gana una clave. Es aditivo.

```json
{
  "numero": 41,
  "decidido": "Los informes llevan la cabecera de la norma.",
  "tema": "proceso",
  "norma": { "documento": "docs/SP3-canon.md", "apartado": "§7.5" },
  "estado": "inactiva",
  "inactivacion": { "motivo": "Ya lo dice el canon.", "sustituida_por": null }
}
```

Una activa recogida en una norma sale igual, con `"estado": "activa"` e
`"inactivacion": null`. Una que no está en ninguna norma sale con
`"norma": null`.

Vale de una vez para el endpoint, para el conector y para el botón de exportar,
porque los tres pasan por `src/lib/decisiones-document.ts`. Sigue siendo verdad
que lo que exporta la aplicación es byte a byte lo que devuelve
`/api/decisiones`.

**`/api/roadmap` no se ha tocado.** Sus bytes son los de siempre.

### El conector

La descripción de `leer_decisiones` está reescrita: un agente solo sabe lo que
dice la descripción, y ahora dice que existe la norma, qué significa en una
decisión activa, y cómo se lee un `sustituida_por` nulo.

Dos filtros nuevos, que contestan las dos preguntas que se hacen de verdad:

- `norma: "docs/SP3-canon.md"` — qué decisiones dependen de ese documento, antes
  de enmendarlo. No distingue mayúsculas y no mira el apartado.
- `recogida: true | false` — las que están en una norma, o las que no están en
  ninguna. Cruzado con `estado: "activa"`, es exactamente "qué queda por
  escribir".

### La pantalla

- Dos campos más en el formulario de la decisión —"Norma que la recoge" y
  "Apartado"—, que aparecen igual al escribir una nueva, al corregir una y al
  escribir la sustituta dentro del modal de retirada.
- Un tercer botón en la retirada: **"Apuntar a una norma"**, junto a "Escribirla
  aquí" y "Elegir una que ya existe".
- Un segundo grupo de filtros en la lista: **Todas / En una norma / Sin norma**.
  Es un eje aparte del de estado porque son dos preguntas que se cruzan.
- En la lista, una marca "en norma" en las decisiones recogidas, y el pie de una
  inactiva dice "la recoge docs/SP3-canon.md §7.5" cuando la retira su norma.
- El buscador mira también el texto de la norma: "canon" encuentra las que
  apuntan al canon sin cambiar de filtro.
- El recuento de arriba dice cuántas están en una norma.

Dos cosas que la pantalla hace a propósito:

- **La sustituta que se escribe entera no hereda la norma de la vieja.** Si la
  vieja estaba en §7.5, ese apartado sigue diciendo lo de la vieja hasta que
  alguien lo enmiende. Heredarlo sería firmar por la nueva algo que todavía no
  es verdad. El campo está ahí para escribirlo cuando lo sea.
- A una inactiva a la que la sustituye su norma, quitarle el documento se
  rechaza con palabras y no con un fallo de Postgres.

---

## Cómo se usa

**Retirar una decisión apuntando a una norma.** Se abre la decisión, "Inactivar
la decisión N", se escribe por qué se retira, se elige "Apuntar a una norma", se
pone `docs/SP3-canon.md` y `§7.5`, y se acepta. Una sola escritura: o queda
retirada apuntando a la norma, o no pasa nada.

**Marcar una activa sin retirarla.** Se abre la decisión, se rellenan los dos
campos de la norma y se guarda la corrección. Sigue activa, y queda en el rastro
qué decía antes.

**Las 103 de golpe, por fichero.** Se exporta el decisor, se añade `"norma"` a
las entradas que corresponda y se reimporta:

```json
{
  "decidido": "Los informes llevan la cabecera de la norma.",
  "fecha": "2026-06-02",
  "motivo": "Sin cabecera no se sabe bajo que regla se escribio.",
  "tema": "proceso",
  "norma": { "documento": "docs/SP3-canon.md", "apartado": "§7.5" }
}
```

Y si además se quieren retirar, `"inactiva"` con su motivo y **sin**
`sustituida_por`:

```json
{
  "decidido": "El acta se puede cerrar cuando se pueda.",
  "fecha": "2026-05-01",
  "motivo": "Habia prisa.",
  "tema": "proceso",
  "norma": { "documento": "docs/SP3-canon.md", "apartado": "§9.1" },
  "inactiva": { "motivo": "Ya lo dice el canon; la decision sobra." }
}
```

`sustituida_por` deja de ser obligatorio dentro de `inactiva`, pero sigue
haciendo falta una de las dos cosas. Una decisión no se retira sin decir qué la
sustituye.

La norma se escribe como objeto y no como la cadena `"docs/SP3-canon.md §7.5"`,
porque partir esa cadena sería adivinar dónde acaba el documento y empieza el
apartado — y porque el verificador de Songplay tendrá que preguntar por el
documento sin partir texto a ojo.

**La excepción de la importación.** Importar sigue sin pisar lo que ya hay, con
una salvedad: si la entrada trae `norma` y la decisión que ya existe tiene otra
o ninguna, se le pone. Sin eso, el camino de arriba no haría nada: las 103 se
contarían como ya escritas y la norma se perdería. Nunca al revés — una entrada
sin `norma` no borra la que hubiera. La pantalla lo dice antes de escribir, con
los números: "A 103 de esas se les pondrá la norma que trae el fichero".

---

## Qué sigue igual

- **Las 173 decisiones**: intactas. Aquí no se ha tocado ninguna decisión del
  decisor: ni se ha inactivado, ni se ha corregido, ni se ha borrado ninguna.
- **Las 5 inactivaciones y todas las correcciones**: como estaban.
- **Los ficheros JSON que ya existen**: entran igual. `norma` es opcional, y el
  validador solo rechaza campos que no reconoce.
- **El formulario**: los campos nuevos son opcionales; no hay ninguna decisión
  que haya que completar.
- **`/api/roadmap`** y el generador del roadmap de Songplay.

Lo único que cambia para quien lee de fuera: **las respuestas de
`/api/decisiones` y de `leer_decisiones` ganan una clave por decisión**, así que
sus bytes cambian. Quien parsea JSON no se entera. Si en Songplay hubiera algo
que compare esa respuesta byte a byte, se enteraría — hay que mirarlo allí (ver
abajo).

## Lo que se ha ejercitado

| Verificador | Qué cubre | Resultado |
|---|---|---|
| `scripts/sql/01-pruebas-oauth.sql` | sin tocar | 28/28 |
| `scripts/sql/02-pruebas-decisiones.sql` | sin tocar | 48/48 |
| `scripts/sql/03-pruebas-importar.sql` | sin tocar | 24/24 |
| `scripts/sql/04-pruebas-inactivar.sql` | sin tocar | 23/23 |
| `scripts/sql/05-pruebas-norma.sql` | **nuevo**: la norma de punta a punta | 38/38 |
| `npm run verificar-import` | el fichero JSON, con y sin normas | todo correcto |
| `npm run verificar-mcp` | el conector, con los dos filtros nuevos | todo correcto |
| `npm run verificar-api` | `/api/roadmap`, sin cambios | todo correcto |

Que los cuatro ficheros SQL anteriores pasen **sin tocarles una línea** es la
prueba de que lo que ya había sigue funcionando igual.

El de la norma comprueba, sobre todo, lo que no se ve cuando sale bien: que un
apartado sin documento no entra, que una decisión no se puede retirar sin decir
qué ocupa su sitio, que dos sustitutos a la vez se rechazan, y que una
importación que falla a la mitad no deja nada escrito.

```bash
PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/verificar-esquema.sh
```

La pantalla está comprobada por tipos y compilación, no ejecutada contra la base
real. La lógica que decide qué se escribe —el validador del fichero, el modelo
del documento— sí está ejercitada entera, porque es pura.

## Lo que falta por hacer aquí

**La migración no está aplicada.** Está escrita y probada contra un Postgres de
usar y tirar, pero no se ha subido a Supabase. Hay que aplicarla:

```bash
npx supabase db push --db-url "postgresql://postgres.kmlurbgkyssdowfapdiz:$SUPABASE_DB_PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
```

Y desplegar la aplicación. El orden no importa: la migración no rompe el
frontend viejo, y el frontend nuevo no funciona sin la migración.

---

## Qué habría que hacer en Songplay para aprovecharlo

Nada de esto es de Arboria, y nada de esto se ha tocado.

1. **La limpieza.** Exportar el decisor, marcar las 103 con el documento y el
   apartado que las recoge, y decidir una por una si se retiran o se quedan
   activas con su norma. Son dos cosas distintas: una decisión puede estar
   escrita en el canon y seguir siendo útil como registro de por qué se decidió.

2. **El verificador.** Con el campo puesto, el verificador de Songplay puede
   avisar cuando una norma se enmiende y una decisión **activa** siga diciendo lo
   de antes. La consulta es una llamada al conector:

   ```
   leer_decisiones(norma: "docs/SP3-canon.md", estado: "activa")
   ```

   Devuelve las decisiones activas que dependen de ese documento. Si el
   documento cambia y alguna de ellas no se ha tocado, hay algo que revisar.

   La otra mitad de la pregunta:

   ```
   leer_decisiones(recogida: false, estado: "activa")
   ```

   Las que todavía no están escritas en ninguna norma, que es la lista de lo que
   queda por canonizar.

3. **Comprobar que nada compara bytes.** Si algún generador o verificador de
   Songplay compara la respuesta de `/api/decisiones` byte a byte —como sí hace
   con `/api/roadmap`—, hay que actualizar su referencia: cada decisión tiene
   ahora una clave `norma` más. Lo que parsea JSON no necesita nada.

4. **Nombrar los documentos igual siempre.** El campo es texto suelto a
   propósito: Arboria no sabe —ni debe saber— si `docs/SP3-canon.md` existe. Eso
   significa que `docs/SP3-canon.md` y `SP3-canon.md` son dos normas distintas
   para el filtro. Merece una convención escrita en Songplay antes de marcar las
   103.
