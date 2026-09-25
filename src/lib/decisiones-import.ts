/**
 * El fichero de decisiones que Ruben sube en la aplicacion, y su validacion.
 *
 * Esto no es una puerta de escritura desde fuera: lo lee la pantalla del
 * decisor, con la sesion de Ruben, igual que el formulario. Escribir a mano es
 * escribirlas de una en una o traerlas en un fichero que sube el; lo que no
 * hay es una ruta por la que escriba una API ni un agente.
 *
 * El modulo es puro a proposito —entra texto, sale o un plan de importacion o
 * una lista de errores— para poder ejercitarlo entero sin navegador y sin base.
 *
 * Decisiones de formato, y por que:
 *
 * - La fecha se escribe AAAA-MM-DD y solo asi. "03/04/2026" son dos dias
 *   distintos segun quien lo lea, y este fichero tiene que querer decir lo
 *   mismo dentro de un ano. Ademas se comprueba que la fecha existe: 2026-02-31
 *   se rechaza.
 * - No hay identificadores tecnicos salvo uno, "ref", y solo hace falta cuando
 *   otra entrada del fichero senala a esa. Es una etiqueta que pone Ruben, no
 *   un uuid: "tabla-propia" vale.
 * - "sustituida_por" admite las dos cosas que pueden pasar: el ref de otra
 *   entrada del mismo fichero, o el numero de una decision ya escrita. Texto es
 *   un ref; numero es una que ya esta.
 * - Un campo que no se reconoce es un error, no algo que se ignora. En un
 *   fichero escrito a mano, "por que" en vez de "motivo" es una errata, y
 *   tragarsela en silencio seria perder el motivo sin avisar.
 * - "norma" es la que recoge la decision, y va en la entrada, no dentro de
 *   "inactiva": es el mismo dato tanto si la decision se retira como si sigue
 *   activa. Se escribe como objeto —{"documento": "...", "apartado": "..."}—
 *   y no como la cadena "docs/SP3-canon.md §7.5", porque partir esa cadena
 *   seria adivinar donde acaba el documento y empieza el apartado.
 * - Con "norma" puesta, "inactiva" ya no necesita "sustituida_por": lo que
 *   ocupa el sitio de la decision es la norma. Lo que sigue sin poder pasar es
 *   retirar una decision sin decir que la sustituye.
 */

export type NormaDeFichero = {
  documento: string
  apartado: string | null
}

export type EntradaDeFichero = {
  ref: string | null
  decidido: string
  fecha: string
  motivo: string
  tema: string
  detalle: string | null
  nodo: string | null
  norma: NormaDeFichero | null
  /**
   * "sustituida_por" nulo quiere decir que la retira su norma, que es la de la
   * propia entrada. Sin norma, una entrada asi no llega hasta aqui.
   */
  inactiva: { motivo: string; sustituida_por: string | number | null } | null
}

export type DecisionExistente = {
  numero: number
  decidido: string
  fecha: string
  /** Si ya esta retirada. Una que lo esta no se vuelve a retirar. */
  estado: 'activa' | 'inactiva'
  /** La que tiene escrita ahora mismo, para saber si el fichero la cambia. */
  norma: NormaDeFichero | null
}

export type PlanDeImportacion = {
  /** Lo que se mandara a la base, en el orden del fichero. */
  entradas: EntradaDeFichero[]
  /** Cuantas se escribiran. */
  nuevas: number
  /**
   * Las que ya estaban escritas, con el numero que tienen, y que se les va a
   * hacer: ponerles la norma del fichero, retirarlas, o nada.
   */
  yaEstaban: Array<{
    posicion: number
    numero: number
    decidido: string
    norma: boolean
    retirar: boolean
    yaInactiva: boolean
  }>
  /**
   * Cuantas de las que se escriben nacen ya inactivas. Solo las nuevas: las
   * que ya estaban escritas y se retiran se cuentan en "retiradas", porque
   * decir "se escribiran 0, 9 de ellas inactivas" no lo entiende nadie.
   */
  inactivaciones: number
  /** A cuantas de las que ya estaban escritas y siguen activas se les retirara. */
  retiradas: number
  /** Cuantas de las que ya estaban escritas ya estaban retiradas. No se tocan. */
  yaInactivas: number
  /** A cuantas de las que ya estaban escritas se les pondra la norma. */
  normasPuestas: number
}

export type ResultadoDeLectura =
  | { ok: true; plan: PlanDeImportacion }
  | { ok: false; errores: string[] }

const CAMPOS = new Set([
  'ref',
  'decidido',
  'fecha',
  'motivo',
  'tema',
  'detalle',
  'nodo',
  'norma',
  'inactiva',
])

const CAMPOS_DE_INACTIVA = new Set(['motivo', 'sustituida_por'])

const CAMPOS_DE_NORMA = new Set(['documento', 'apartado'])

function esFechaDeVerdad(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false
  const [ano, mes, dia] = valor.split('-').map(Number)
  if (mes < 1 || mes > 12 || dia < 1) return false
  // El dia 0 del mes siguiente es el ultimo del mes, y asi los bisiestos salen
  // solos sin tabla de meses.
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate()
  return dia <= ultimo
}

function comoTexto(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim() : ''
}

function referencia(entrada: Record<string, unknown>, posicion: number): string {
  const decidido = comoTexto(entrada.decidido)
  const resumen = decidido ? `"${decidido.slice(0, 48)}${decidido.length > 48 ? '...' : ''}"` : ''
  return `Entrada ${posicion}${resumen ? ` (${resumen})` : ''}`
}

/**
 * Lee el fichero y devuelve el plan, o todos los errores que encuentre.
 *
 * Todos, no el primero: quien escribe un fichero a mano prefiere enterarse de
 * las cinco cosas que le faltan de una vez y no de una en una.
 */
export function leerFicheroDeDecisiones(
  texto: string,
  existentes: DecisionExistente[],
): ResultadoDeLectura {
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch (error) {
    return {
      ok: false,
      errores: [`El fichero no es JSON valido: ${error instanceof Error ? error.message : ''}`],
    }
  }

  // Se admite la lista pelada y el objeto con "decisiones" dentro. Nada mas:
  // adivinar formas es como se acaba importando algo que no era.
  const lista = Array.isArray(crudo)
    ? crudo
    : crudo && typeof crudo === 'object' && Array.isArray((crudo as { decisiones?: unknown }).decisiones)
      ? ((crudo as { decisiones: unknown[] }).decisiones)
      : null

  if (!lista) {
    return {
      ok: false,
      errores: [
        'El fichero tiene que ser una lista de decisiones, o un objeto con una ' +
          'clave "decisiones" que contenga esa lista.',
      ],
    }
  }

  if (lista.length === 0) {
    return { ok: false, errores: ['El fichero no trae ninguna decision.'] }
  }

  const errores: string[] = []
  const entradas: EntradaDeFichero[] = []
  const refsVistos = new Map<string, number>()

  lista.forEach((valor, indice) => {
    const posicion = indice + 1
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
      errores.push(`Entrada ${posicion}: no es una decision.`)
      return
    }

    const entrada = valor as Record<string, unknown>
    const donde = referencia(entrada, posicion)

    const sobran = Object.keys(entrada).filter((campo) => !CAMPOS.has(campo))
    if (sobran.length > 0) {
      errores.push(
        `${donde}: no reconozco ${sobran.map((campo) => `"${campo}"`).join(', ')}. ` +
          `Los campos son: ${[...CAMPOS].join(', ')}.`,
      )
    }

    const decidido = comoTexto(entrada.decidido)
    if (!decidido) errores.push(`${donde}: falta "decidido", que es que se decidio.`)
    else if (decidido.length > 20000) errores.push(`${donde}: "decidido" se pasa de largo.`)

    const fecha = comoTexto(entrada.fecha)
    if (!fecha) errores.push(`${donde}: falta "fecha".`)
    else if (!esFechaDeVerdad(fecha)) {
      errores.push(`${donde}: "${fecha}" no es una fecha. Se escriben AAAA-MM-DD.`)
    }

    const motivo = comoTexto(entrada.motivo)
    if (!motivo) errores.push(`${donde}: falta "motivo", que es por que se decidio.`)

    const tema = comoTexto(entrada.tema)
    if (!tema) errores.push(`${donde}: falta "tema".`)
    else if (tema.length > 200) errores.push(`${donde}: "tema" se pasa de largo.`)

    const detalle = comoTexto(entrada.detalle) || null
    const nodo = comoTexto(entrada.nodo) || null

    let norma: NormaDeFichero | null = null
    if (entrada.norma !== undefined && entrada.norma !== null) {
      const cruda = entrada.norma
      if (!cruda || typeof cruda !== 'object' || Array.isArray(cruda)) {
        errores.push(
          `${donde}: "norma" tiene que llevar dentro "documento" y, si hace falta, "apartado".`,
        )
      } else {
        const bloque = cruda as Record<string, unknown>
        const sobranDentro = Object.keys(bloque).filter((campo) => !CAMPOS_DE_NORMA.has(campo))
        if (sobranDentro.length > 0) {
          errores.push(
            `${donde}: dentro de "norma" no reconozco ` +
              `${sobranDentro.map((campo) => `"${campo}"`).join(', ')}. ` +
              'Son "documento" y "apartado".',
          )
        }

        const documento = comoTexto(bloque.documento)
        const apartado = comoTexto(bloque.apartado) || null

        if (!documento) {
          // Un apartado suelto no se puede leer: "§7.5" de donde.
          errores.push(
            `${donde}: "norma" sin "documento". Es el documento que recoge la ` +
              'decision, por ejemplo "docs/SP3-canon.md".',
          )
        } else if (documento.length > 400) {
          errores.push(`${donde}: el "documento" de la norma se pasa de largo.`)
        } else if (apartado && apartado.length > 200) {
          errores.push(`${donde}: el "apartado" de la norma se pasa de largo.`)
        } else {
          norma = { documento, apartado }
        }
      }
    }

    let ref: string | null = null
    if (entrada.ref !== undefined && entrada.ref !== null) {
      ref = comoTexto(entrada.ref)
      if (!ref) errores.push(`${donde}: "ref" esta vacio.`)
      else if (refsVistos.has(ref)) {
        errores.push(`${donde}: el ref "${ref}" ya lo usa la entrada ${refsVistos.get(ref)}.`)
      } else refsVistos.set(ref, posicion)
    }

    let inactiva: EntradaDeFichero['inactiva'] = null
    if (entrada.inactiva !== undefined && entrada.inactiva !== null) {
      const cruda = entrada.inactiva
      if (!cruda || typeof cruda !== 'object' || Array.isArray(cruda)) {
        errores.push(`${donde}: "inactiva" tiene que llevar dentro "motivo" y "sustituida_por".`)
      } else {
        const bloque = cruda as Record<string, unknown>
        const sobranDentro = Object.keys(bloque).filter((campo) => !CAMPOS_DE_INACTIVA.has(campo))
        if (sobranDentro.length > 0) {
          errores.push(
            `${donde}: dentro de "inactiva" no reconozco ` +
              `${sobranDentro.map((campo) => `"${campo}"`).join(', ')}.`,
          )
        }

        const motivoBaja = comoTexto(bloque.motivo)
        if (!motivoBaja) errores.push(`${donde}: "inactiva" sin "motivo". Hay que decir por que se quita.`)

        const cual = bloque.sustituida_por
        if (cual === undefined || cual === null || cual === '') {
          // Sin "sustituida_por" la retira su norma, que es la de la entrada.
          // Sin ninguna de las dos no se retira: la regla no cambia, solo
          // admite una segunda forma de cumplirla.
          if (!norma) {
            errores.push(
              `${donde}: "inactiva" sin "sustituida_por" y sin "norma". Una decision ` +
                'se quita porque otra ocupa su sitio, o porque ya la recoge una norma.',
            )
          } else if (motivoBaja) {
            inactiva = { motivo: motivoBaja, sustituida_por: null }
          }
        } else if (typeof cual !== 'string' && typeof cual !== 'number') {
          errores.push(`${donde}: "sustituida_por" es el ref de otra entrada, o el numero de una ya escrita.`)
        } else if (motivoBaja) {
          inactiva = { motivo: motivoBaja, sustituida_por: typeof cual === 'string' ? cual.trim() : cual }
        }
      }
    }

    entradas.push({ ref, decidido, fecha, motivo, tema, detalle, nodo, norma, inactiva })
  })

  // Con que decision ya escrita casa cada entrada, si casa con alguna: es la
  // que dice lo mismo el mismo dia. Se calcula aqui arriba y no al final
  // porque hace falta para dos cosas distintas —avisar de que una entrada se
  // sustituye a si misma, y decir que va a pasar con las que ya estaban— y
  // calcularlo dos veces seria pedir que las dos se desincronicen.
  const claveExistente = new Map(
    existentes.map((fila) => [`${fila.fecha}|${fila.decidido.trim()}`, fila]),
  )
  const casaCon = (entrada: EntradaDeFichero) =>
    claveExistente.get(`${entrada.fecha}|${entrada.decidido}`) ?? null

  // Las sustituciones se comprueban con el fichero entero leido, porque una
  // entrada puede senalar a otra que viene despues.
  const numerosExistentes = new Set(existentes.map((fila) => fila.numero))
  entradas.forEach((entrada, indice) => {
    if (!entrada.inactiva) return
    const posicion = indice + 1
    const donde = `Entrada ${posicion} ("${entrada.decidido.slice(0, 48)}")`
    const cual = entrada.inactiva.sustituida_por

    // La retira su norma: no hay nada que cruzar con el resto del fichero.
    if (cual === null) return

    if (typeof cual === 'number') {
      if (!numerosExistentes.has(cual)) {
        errores.push(
          `${donde}: dice que la sustituye la decision ${cual}, y en este proyecto no hay ninguna con ese numero.`,
        )
        return
      }
      // La errata tipica de un fichero de poda escrito a mano: la entrada es
      // una decision que ya existe, y se pone a si misma como sustituta. La
      // tabla ya lo rechaza, pero tumbando el fichero entero con un mensaje de
      // Postgres; dicho aqui se entiende y se arregla.
      if (casaCon(entrada)?.numero === cual) {
        errores.push(`${donde}: es la decision ${cual}, asi que se sustituye a si misma.`)
      }
      return
    }

    if (!refsVistos.has(cual)) {
      errores.push(
        `${donde}: dice que la sustituye "${cual}", y ninguna entrada del fichero lleva ese ref. ` +
          'Si es una decision ya escrita, pon su numero en vez del nombre.',
      )
      return
    }
    if (refsVistos.get(cual) === posicion) {
      errores.push(`${donde}: se sustituye a si misma.`)
    }
  })

  if (errores.length > 0) return { ok: false, errores }

  // Una decision ya escrita es la que dice lo mismo el mismo dia. Se deja como
  // esta: importar no pisa lo que ya hay. Vale para volver a intentar un
  // fichero que fallo a la mitad sin miedo a duplicar nada.
  //
  // Con una sola excepcion, la norma. Si la entrada trae una y la decision que
  // ya existe tiene otra o no tiene ninguna, se le pone. Sin esa excepcion, el
  // camino natural para marcar cien decisiones de golpe —exportar, anadir la
  // norma, reimportar— no haria nada, porque las cien se contarian como ya
  // escritas. Nunca al reves: una entrada sin norma no borra la que hubiera.
  //
  // Y la otra cosa que si cambia de una que ya estaba: retirarla. Una entrada
  // con "inactiva" que casa con una decision ya escrita la retira, igual que
  // si se hubiera abierto en la pantalla. Si esa decision ya estaba retirada,
  // no se toca: retirar es un acto y no se hace dos veces.
  const yaEstaban: PlanDeImportacion['yaEstaban'] = []
  entradas.forEach((entrada, indice) => {
    const fila = casaCon(entrada)
    if (!fila) return
    const cambiaLaNorma =
      entrada.norma !== null &&
      (entrada.norma.documento !== fila.norma?.documento ||
        entrada.norma.apartado !== (fila.norma?.apartado ?? null))
    yaEstaban.push({
      posicion: indice + 1,
      numero: fila.numero,
      decidido: entrada.decidido,
      norma: cambiaLaNorma,
      retirar: entrada.inactiva !== null && fila.estado === 'activa',
      yaInactiva: entrada.inactiva !== null && fila.estado === 'inactiva',
    })
  })

  return {
    ok: true,
    plan: {
      entradas,
      nuevas: entradas.length - yaEstaban.length,
      yaEstaban,
      // Solo las que nacen inactivas. Las que ya estaban van en "retiradas".
      inactivaciones: entradas.filter((entrada) => entrada.inactiva && !casaCon(entrada)).length,
      retiradas: yaEstaban.filter((fila) => fila.retirar).length,
      yaInactivas: yaEstaban.filter((fila) => fila.yaInactiva).length,
      normasPuestas: yaEstaban.filter((fila) => fila.norma).length,
    },
  }
}

/** El ejemplo que se ensena en la pantalla, y que sirve de plantilla. */
export const ejemploDeFichero = `{
  "decisiones": [
    {
      "ref": "tabla-propia",
      "decidido": "El decisor va en tabla propia, no dentro del documento del roadmap.",
      "fecha": "2026-09-20",
      "motivo": "La respuesta de /api/roadmap es byte a byte la exportacion, y Songplay lo comprueba.",
      "tema": "arquitectura",
      "detalle": "Informe del decisor, apartado 1",
      "nodo": "SP"
    },
    {
      "decidido": "Las decisiones se guardan en el documento, junto al arbol.",
      "fecha": "2026-09-14",
      "motivo": "Era lo mas barato de construir.",
      "tema": "arquitectura",
      "inactiva": {
        "motivo": "Cambiaria los bytes que ya consume Songplay.",
        "sustituida_por": "tabla-propia"
      }
    },
    {
      "decidido": "Los informes llevan la cabecera de la norma.",
      "fecha": "2026-06-02",
      "motivo": "Sin cabecera no se sabe bajo que regla se escribio.",
      "tema": "proceso",
      "norma": { "documento": "docs/SP3-canon.md", "apartado": "§7.5" }
    },
    {
      "decidido": "Un informe se cierra diciendo que se ha cambiado.",
      "fecha": "2026-06-02",
      "motivo": "Un informe sin cierre no se puede verificar.",
      "tema": "proceso",
      "norma": { "documento": "docs/SP3-canon.md", "apartado": "§7.6" },
      "inactiva": {
        "motivo": "Ya lo dice el canon; la decision sobra."
      }
    }
  ]
}
`
