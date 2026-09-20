/**
 * Lectura del roadmap. Solo lectura: no hay aqui ninguna ruta que escriba.
 *
 * GET /api/roadmap
 * Authorization: Bearer <clave del proyecto>
 *
 * Devuelve exactamente los bytes que produce el boton de exportar de Arboria:
 * el documento pasado por normalizeRoadmapDocument y serializado por
 * stringifyRoadmapJson, con indentacion de 2 y salto de linea final. Ese
 * requisito manda sobre todo lo demas, porque el generador del roadmap de
 * Songplay comprueba que su markdown corresponde al JSON.
 *
 * Por eso no se puede devolver la columna jsonb tal cual: jsonb reordena las
 * claves de cada objeto por longitud y luego por bytes, y el estado de las
 * ramas es derivado, no almacenado. El normalizador arregla las dos cosas, y
 * es el mismo modulo que usa la aplicacion.
 *
 * La clave no viaja en la URL. Nunca se usa la clave de servicio de Supabase:
 * se llama con la clave anonima, que ya es publica en el bundle desplegado, a
 * una funcion security definer cuyo alcance es un documento.
 *
 * La llamada a Supabase y la normalizacion viven en netlify/lib/roadmap-lectura.ts
 * porque el servidor MCP hace exactamente lo mismo con otra credencial.
 */
import { RichTextUnavailableError, stringifyRoadmapJson } from '../../src/lib/roadmap-document.ts'
import { ErrorDeLectura, documentoDesdeRpc } from '../lib/roadmap-lectura.ts'

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
    const documento = await documentoDesdeRpc('roadmap_document_by_key', { api_key: clave })
    return new Response(stringifyRoadmapJson(documento), { status: 200, headers: CABECERAS })
  } catch (error) {
    if (error instanceof ErrorDeLectura) return fallo(STATUS[error.codigo], error.codigo)
    // Sanear ideas[] con contenido necesita parsear HTML de verdad y aqui no
    // hay DOM. Se falla en alto en vez de devolver unos bytes distintos de los
    // que produce la exportacion.
    if (error instanceof RichTextUnavailableError) return fallo(409, 'ideas_require_dom')
    return fallo(500, 'normalization_failed')
  }
}
