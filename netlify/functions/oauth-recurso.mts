/**
 * Metadatos del recurso protegido (RFC 9728).
 *
 * GET /.well-known/oauth-protected-resource
 * GET /.well-known/oauth-protected-resource/mcp
 *
 * Es el primer documento que pide un cliente MCP cuando el servidor le
 * contesta 401, porque la cabecera WWW-Authenticate apunta aqui. Lo unico que
 * dice es cual es la identidad canonica de este servidor y quien emite los
 * tokens que valen en el.
 *
 * Se sirve en las dos rutas porque la especificacion deja al cliente elegir:
 * la de la raiz, y la que lleva el camino del recurso pegado detras.
 */
import { CORS, json, origenPublico, preflight } from '../lib/http.ts'
import { metadatosDelRecurso } from '../../src/lib/mcp-conector.ts'

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' })
  }

  return new Response(`${JSON.stringify(metadatosDelRecurso(origenPublico(request)), null, 2)}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...CORS,
    },
  })
}
