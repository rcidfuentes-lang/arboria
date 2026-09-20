/**
 * Registro dinamico de clientes (RFC 7591).
 *
 * POST /oauth/registro
 *
 * Es publico, y tiene que serlo: el cliente todavia no tiene con que
 * autenticarse. claude.ai lo usa para darse de alta solo, sin que Ruben tenga
 * que copiar ningun identificador a ninguna parte.
 *
 * Registrarse no da acceso a nada. Lo unico que sale de aqui es un client_id
 * que sirve para pedir permiso; el permiso lo concede Ruben en la pantalla de
 * autorizacion, eligiendo el proyecto. Las comprobaciones de verdad —que las
 * redirecciones sean https o localhost, y el tope de altas por hora— estan en
 * la funcion de la base, no aqui, porque esta ruta no es la unica manera de
 * llamarla.
 */
import { cuerpoDeFormulario, json, preflight } from '../lib/http.ts'
import { ErrorDeRpc, llamarRpc } from '../lib/supabase-rpc.ts'

function invalido(descripcion: string): Response {
  return json({ error: 'invalid_client_metadata', error_description: descripcion }, 400)
}

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' })
  }

  let peticion: Record<string, unknown>
  try {
    peticion = (await request.json()) as Record<string, unknown>
  } catch {
    // Algun cliente manda el alta como formulario. No cuesta nada admitirlo.
    peticion = await cuerpoDeFormulario(request)
  }

  const nombre =
    typeof peticion.client_name === 'string' && peticion.client_name.trim()
      ? peticion.client_name.trim()
      : 'Cliente MCP'

  const redirecciones = Array.isArray(peticion.redirect_uris)
    ? peticion.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
    : []

  if (redirecciones.length === 0) {
    return invalido('Hace falta redirect_uris con al menos una direccion.')
  }

  let alta: unknown
  try {
    alta = await llamarRpc('mcp_register_client', {
      client_name: nombre,
      redirect_uris: redirecciones,
    })
  } catch (error) {
    if (error instanceof ErrorDeRpc && error.motivo === 'no_configurado') {
      return json({ error: 'server_error', error_description: 'server_not_configured' }, 500)
    }
    return json({ error: 'server_error' }, 502)
  }

  if (alta === null || typeof alta !== 'object') {
    return invalido(
      'Las redirecciones tienen que ser https, o http contra localhost, sin fragmento.',
    )
  }

  const registrado = alta as Record<string, unknown>

  return json(
    {
      client_id: registrado.client_id,
      client_id_issued_at: registrado.client_id_issued_at,
      client_name: registrado.client_name,
      redirect_uris: registrado.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Cliente publico: no hay secreto porque no hay donde guardarlo. Lo que
      // protege el codigo de autorizacion es PKCE.
      token_endpoint_auth_method: 'none',
    },
    201,
  )
}
