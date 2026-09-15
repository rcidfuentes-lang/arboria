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
 */
import {
  RichTextUnavailableError,
  normalizeRoadmapDocument,
  stringifyRoadmapJson,
} from '../../src/lib/roadmap-document.ts'

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

export default async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') return fallo(405, 'method_not_allowed')

  const clave = claveDe(request)
  if (!clave) return fallo(401, 'unauthorized')

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!supabaseUrl || !supabaseKey) return fallo(500, 'server_not_configured')

  let respuesta: Response
  try {
    respuesta = await fetch(`${supabaseUrl}/rest/v1/rpc/roadmap_document_by_key`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: clave }),
    })
  } catch {
    return fallo(502, 'roadmap_lookup_failed')
  }

  if (!respuesta.ok) return fallo(502, 'roadmap_lookup_failed')

  const almacenado: unknown = await respuesta.json()

  // Clave inexistente, revocada, o de un proyecto que ya no esta: la funcion
  // devuelve null y aqui se responde lo mismo que a una peticion sin clave.
  // Nada en la respuesta dice si algun proyecto existe.
  if (almacenado === null) return fallo(401, 'unauthorized')
  if (!esDocumento(almacenado)) return fallo(409, 'invalid_roadmap_document')

  try {
    return new Response(stringifyRoadmapJson(normalizeRoadmapDocument(almacenado)), {
      status: 200,
      headers: CABECERAS,
    })
  } catch (error) {
    // Sanear ideas[] con contenido necesita parsear HTML de verdad y aqui no
    // hay DOM. Se falla en alto en vez de devolver unos bytes distintos de los
    // que produce la exportacion.
    if (error instanceof RichTextUnavailableError) return fallo(409, 'ideas_require_dom')
    return fallo(500, 'normalization_failed')
  }
}
