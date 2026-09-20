import type {
  Decision,
  DecisionCorreccion,
  DecisionEstado,
  DecisionFila,
  DecisionHistorialFila,
  DecisionesDocument,
} from '../types/decisiones'

/**
 * Modelo del decisor: normaliza y serializa las decisiones de un proyecto.
 *
 * Es el gemelo de roadmap-document.ts y existe por la misma razon: que la
 * aplicacion, la API de lectura y el conector produzcan los mismos bytes
 * porque pasan por el mismo codigo, y no porque alguien se acuerde de
 * mantener tres copias iguales.
 *
 * Con una diferencia que importa: aqui no hay DOM que resolver. Las decisiones
 * son texto plano, asi que este modulo no necesita DOMParser y no puede
 * tropezar con lo que hoy tumba la lectura del roadmap cuando hay una idea
 * escrita. Nada de lo que entra se interpreta como marcado en ningun sitio.
 */

export const temasSugeridos = [
  'arquitectura',
  'producto',
  'proceso',
  'datos',
  'seguridad',
  'alcance',
]

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : String(valor ?? '')
}

function textoOpcional(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null
  const limpio = texto(valor).trim()
  return limpio === '' ? null : limpio
}

function estado(valor: unknown): DecisionEstado {
  return valor === 'inactiva' ? 'inactiva' : 'activa'
}

function normalizeCorreccion(valor: unknown): DecisionCorreccion {
  const fila = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>
  return {
    campo: texto(fila.campo),
    antes: fila.antes === null || fila.antes === undefined ? null : texto(fila.antes),
    despues: fila.despues === null || fila.despues === undefined ? null : texto(fila.despues),
    cuando: texto(fila.cuando),
  }
}

function normalizeDecision(valor: unknown): Decision {
  const fila = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>
  const inactivacion = (fila.inactivacion && typeof fila.inactivacion === 'object'
    ? fila.inactivacion
    : null) as Record<string, unknown> | null
  const cual = inactivacion?.sustituida_por

  return {
    numero: Number(fila.numero ?? 0),
    decidido: texto(fila.decidido),
    fecha: texto(fila.fecha).slice(0, 10),
    motivo: texto(fila.motivo),
    tema: texto(fila.tema),
    detalle: textoOpcional(fila.detalle),
    nodo: textoOpcional(fila.nodo),
    estado: estado(fila.estado),
    // Una decision activa no arrastra inactivacion aunque venga en el origen:
    // la base no deja que las dos cosas convivan y aqui se dice igual.
    inactivacion:
      estado(fila.estado) === 'inactiva' && inactivacion
        ? {
            motivo: texto(inactivacion.motivo),
            sustituida_por: cual === null || cual === undefined ? null : Number(cual),
          }
        : null,
    escrita_el: texto(fila.escrita_el),
    corregida_el: fila.corregida_el ? texto(fila.corregida_el) : null,
    correcciones: Array.isArray(fila.correcciones)
      ? fila.correcciones.map(normalizeCorreccion)
      : [],
  }
}

export function normalizeDecisionesDocument(valor: unknown): DecisionesDocument {
  const documento = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>
  const proyecto = (documento.project && typeof documento.project === 'object'
    ? documento.project
    : {}) as Record<string, unknown>

  return {
    schemaVersion: 1,
    project: {
      id: texto(proyecto.id) || 'proyecto',
      name: texto(proyecto.name) || 'Proyecto',
    },
    // Por numero, siempre. El orden de una lista que se lee desde fuera no
    // puede depender de como venga la consulta.
    decisiones: (Array.isArray(documento.decisiones) ? documento.decisiones : [])
      .map(normalizeDecision)
      .sort((una, otra) => una.numero - otra.numero),
  }
}

/**
 * Los mismos dos espacios de indentacion y el mismo salto final que la
 * exportacion del roadmap.
 *
 * No se reutiliza stringifyRoadmapJson a proposito, y no es por duplicar una
 * linea: aquel serializador es parte del contrato de bytes de /api/roadmap, que
 * Songplay comprueba. Atar el decisor a esa funcion significaria que un cambio
 * pensado para las decisiones puede mover los bytes del roadmap.
 */
export function stringifyDecisionesJson(valor: unknown) {
  return `${JSON.stringify(valor, null, 2)}\n`
}

/**
 * De filas de la tabla al documento, para la aplicacion.
 *
 * La API y el conector no pasan por aqui: alli el documento lo arma la propia
 * base y este modulo solo lo normaliza. Esto es para la pantalla, que trabaja
 * con filas porque es la que escribe.
 *
 * El rastro entra por parametro, y no se deja fuera por comodidad, porque lo
 * que exporta la aplicacion tiene que ser exactamente lo que devuelve
 * /api/decisiones. Si aqui faltara, habria dos documentos distintos con el
 * mismo nombre, que es el problema que el roadmap ya resolvio a base de pasar
 * todo por el mismo modulo.
 */
export function documentoDesdeFilas(
  filas: DecisionFila[],
  proyecto: { id: string; name: string },
  historial: DecisionHistorialFila[] = [],
): DecisionesDocument {
  const numeroDe = new Map(filas.map((fila) => [fila.id, fila.numero]))

  const rastroDe = new Map<string, DecisionCorreccion[]>()
  for (const fila of [...historial].sort((una, otra) =>
    una.cambiado_el === otra.cambiado_el
      ? una.campo.localeCompare(otra.campo)
      : una.cambiado_el.localeCompare(otra.cambiado_el),
  )) {
    const lista = rastroDe.get(fila.decision_id) ?? []
    lista.push({
      campo: fila.campo,
      antes: fila.antes,
      despues: fila.despues,
      cuando: fila.cambiado_el,
    })
    rastroDe.set(fila.decision_id, lista)
  }

  return normalizeDecisionesDocument({
    schemaVersion: 1,
    project: proyecto,
    decisiones: filas.map((fila) => ({
      numero: fila.numero,
      decidido: fila.decidido,
      fecha: fila.fecha,
      motivo: fila.motivo,
      tema: fila.tema,
      detalle: fila.detalle,
      nodo: fila.nodo_id,
      estado: fila.estado,
      inactivacion:
        fila.estado === 'inactiva'
          ? {
              motivo: fila.motivo_inactivacion,
              sustituida_por: fila.sustituida_por ? numeroDe.get(fila.sustituida_por) ?? null : null,
            }
          : null,
      escrita_el: fila.created_at,
      corregida_el: fila.updated_at > fila.created_at ? fila.updated_at : null,
      correcciones: rastroDe.get(fila.id) ?? [],
    })),
  })
}
