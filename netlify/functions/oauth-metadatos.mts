/**
 * Metadatos del servidor de autorizacion (RFC 8414).
 *
 * GET /.well-known/oauth-authorization-server
 *
 * El cliente llega aqui despues de leer los metadatos del recurso protegido.
 * Es un documento publico y sin credenciales: solo dice donde estan los tres
 * endpoints y que sabe hacer cada uno.
 */
import { CORS, json, origenPublico, preflight } from '../lib/http.ts'
import { metadatosDelServidor } from '../../src/lib/mcp-conector.ts'

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' })
  }

  return new Response(`${JSON.stringify(metadatosDelServidor(origenPublico(request)), null, 2)}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...CORS,
    },
  })
}
