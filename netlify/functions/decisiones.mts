/**
 * Lectura del decisor. Solo lectura: no hay aqui ninguna ruta que escriba, y
 * la funcion de la base a la que llama tampoco puede escribir.
 *
 * GET /api/decisiones
 * Authorization: Bearer <clave del proyecto>
 *
 * La misma clave que abre /api/roadmap. No hay una clave nueva que repartir ni
 * un permiso nuevo que conceder: una clave identifica un proyecto, y de ese
 * proyecto se leen su arbol y sus decisiones.
 *
 * Por que un endpoint aparte y no un parametro de /api/roadmap: la respuesta
 * de aquel es byte a byte la exportacion de Arboria, y el generador del
 * roadmap de Songplay lo comprueba. Cualquier cosa que se le anada le cambia
 * los bytes a quien ya lee. Esto no le toca nada.
 *
 * La clave no viaja en la URL. Nunca se usa la clave de servicio de Supabase:
 * se llama con la clave anonima a una funcion security definer cuyo alcance es
 * la lista de decisiones de un proyecto.
 */
import { stringifyDecisionesJson } from '../../src/lib/decisiones-document.ts'
import { decisionesDesdeRpc } from '../lib/decisiones-lectura.ts'
import { ErrorDeLectura } from '../lib/roadmap-lectura.ts'

const CABECERAS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function fallo(status: number, code: string): Response {
  return new Response(`${JSON.stringify({ error: code })}\n`, { status, headers: CABECERAS })
}

function claveDe(request: Request): string | null {
  const cabecera = request.headers.get('Authorization')
  if (!cabecera) return null
  const [esquema, ...resto] = cabecera.split(' ')
  if (esquema.toLowerCase() !== 'bearer') return null
  const clave = resto.join(' ').trim()
  return clave || null
}

const STATUS: Record<string, number> = {
  server_not_configured: 500,
  roadmap_lookup_failed: 502,
  unauthorized: 401,
  invalid_roadmap_document: 409,
  normalization_failed: 500,
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') return fallo(405, 'method_not_allowed')

  const clave = claveDe(request)
  if (!clave) return fallo(401, 'unauthorized')

  try {
    const documento = await decisionesDesdeRpc('decisiones_by_key', { api_key: clave })
    return new Response(stringifyDecisionesJson(documento), { status: 200, headers: CABECERAS })
  } catch (error) {
    if (error instanceof ErrorDeLectura) return fallo(STATUS[error.codigo], error.codigo)
    return fallo(500, 'normalization_failed')
  }
}
