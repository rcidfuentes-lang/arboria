import { normalizeRoadmapDocument } from '../../src/lib/roadmap-document.ts'
import { ErrorDeRpc, llamarRpc } from './supabase-rpc.ts'
import type { RoadmapDocument } from '../../src/types/roadmap'

/**
 * Lectura del documento de un proyecto desde una funcion security definer de
 * Supabase, normalizado con el mismo modulo que usa la aplicacion.
 *
 * Esto estaba dentro de netlify/functions/roadmap.mts. Se saca aqui porque el
 * servidor MCP necesita exactamente lo mismo —la misma llamada, la misma
 * comprobacion de que lo almacenado es un roadmap y la misma normalizacion— y
 * copiarlo seria la forma segura de que las dos rutas acaben divergiendo.
 *
 * Lo que cambia entre las dos rutas es solo la credencial y como se traduce un
 * fallo a respuesta HTTP. Por eso aqui no hay ningun Response: se lanza un
 * ErrorDeLectura con un codigo y cada funcion decide su status.
 */

export type CodigoDeFallo =
  | 'server_not_configured'
  | 'roadmap_lookup_failed'
  | 'unauthorized'
  | 'invalid_roadmap_document'
  | 'normalization_failed'

export class ErrorDeLectura extends Error {
  readonly codigo: CodigoDeFallo

  constructor(codigo: CodigoDeFallo) {
    super(codigo)
    this.name = 'ErrorDeLectura'
    this.codigo = codigo
  }
}

/**
 * El normalizador acepta cualquier cosa y devuelve un documento con la forma
 * correcta: un objeto vacio le sale como un roadmap sin fases. Eso, servido
 * como si fuera bueno, seria un roadmap vacio de aspecto plausible. Asi que se
 * exige que lo almacenado ya sea un documento antes de normalizarlo.
 */
function esDocumento(value: unknown): value is { schemaVersion: 1; nodes: unknown[] } {
  if (!value || typeof value !== 'object') return false
  const documento = value as { schemaVersion?: unknown; nodes?: unknown }
  return documento.schemaVersion === 1 && Array.isArray(documento.nodes)
}

/**
 * Llama a una funcion RPC de Supabase y devuelve el documento normalizado.
 *
 * La credencial que abre el documento es un argumento de la funcion que se
 * llame: la clave de lectura en /api/roadmap, el token de acceso en el
 * conector MCP. Lo que pasa despues es lo mismo en los dos casos.
 */
export async function documentoDesdeRpc(
  funcion: string,
  argumentos: Record<string, unknown>,
): Promise<RoadmapDocument> {
  let almacenado: unknown
  try {
    almacenado = await llamarRpc(funcion, argumentos)
  } catch (error) {
    if (error instanceof ErrorDeRpc && error.motivo === 'no_configurado') {
      throw new ErrorDeLectura('server_not_configured')
    }
    throw new ErrorDeLectura('roadmap_lookup_failed')
  }

  // Credencial inexistente, revocada, caducada, o de un proyecto que ya no
  // esta: la funcion devuelve null y quien llama responde lo mismo que a una
  // peticion sin credencial. Nada dice si algun proyecto existe.
  if (almacenado === null) throw new ErrorDeLectura('unauthorized')
  if (!esDocumento(almacenado)) throw new ErrorDeLectura('invalid_roadmap_document')

  return normalizeRoadmapDocument(almacenado)
}
