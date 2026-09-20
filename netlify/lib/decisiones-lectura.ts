import { normalizeDecisionesDocument } from '../../src/lib/decisiones-document.ts'
import { ErrorDeLectura } from './roadmap-lectura.ts'
import { ErrorDeRpc, llamarRpc } from './supabase-rpc.ts'
import type { DecisionesDocument } from '../../src/types/decisiones'

/**
 * Lectura de las decisiones de un proyecto, desde una funcion security definer
 * de Supabase y normalizada con el mismo modulo que usa la aplicacion.
 *
 * Es el gemelo de roadmap-lectura.ts, y esta aparte por la misma razon por la
 * que /api/decisiones no es un parametro de /api/roadmap: lo que ya esta en
 * servicio no se toca. Comparte con el lo unico que tiene sentido compartir,
 * que es como se llama a la base y como se nombran los fallos.
 *
 * Lo que cambia respecto al roadmap, y para bien: aqui no hay HTML que sanear,
 * asi que no hay DOMParser que resolver y no existe el fallo que hoy tumba la
 * lectura del roadmap cuando un proyecto tiene una idea escrita.
 */

/**
 * El normalizador acepta cualquier cosa: un objeto vacio le sale como un
 * decisor sin decisiones. Eso, servido como si fuera bueno, seria una lista
 * vacia de aspecto plausible. Asi que se exige que lo que devuelve la base ya
 * tenga la forma antes de normalizarlo.
 *
 * Ojo con la diferencia entre esto y null: null es "esta credencial no abre
 * nada" y lo trata quien llama como 401. Una lista vacia es "este proyecto
 * todavia no tiene decisiones", que es una respuesta buena.
 */
function esDocumento(valor: unknown): valor is { decisiones: unknown[] } {
  if (!valor || typeof valor !== 'object') return false
  const documento = valor as { decisiones?: unknown; project?: unknown }
  return Array.isArray(documento.decisiones) && typeof documento.project === 'object'
}

export async function decisionesDesdeRpc(
  funcion: string,
  argumentos: Record<string, unknown>,
): Promise<DecisionesDocument> {
  let almacenado: unknown
  try {
    almacenado = await llamarRpc(funcion, argumentos)
  } catch (error) {
    if (error instanceof ErrorDeRpc && error.motivo === 'no_configurado') {
      throw new ErrorDeLectura('server_not_configured')
    }
    throw new ErrorDeLectura('roadmap_lookup_failed')
  }

  if (almacenado === null) throw new ErrorDeLectura('unauthorized')
  if (!esDocumento(almacenado)) throw new ErrorDeLectura('invalid_roadmap_document')

  return normalizeDecisionesDocument(almacenado)
}
