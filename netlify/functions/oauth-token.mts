/**
 * Endpoint de token (OAuth 2.1).
 *
 * POST /oauth/token
 *
 * Dos concesiones, y ninguna mas: canje del codigo de autorizacion con PKCE, y
 * renovacion con rotacion del refresh token. No hay client_credentials, ni
 * password, ni implicito. Un conector que solo lee no necesita ninguna otra
 * forma de conseguir un token, y cada una que no existe es una que no se puede
 * usar mal.
 *
 * Los tokens se generan aqui, con 32 bytes de aleatoriedad, y a la base solo
 * va su SHA-256. Quien mire la tabla no puede leer ningun roadmap.
 *
 * La comprobacion de PKCE y el consumo del codigo pasan dentro de la base, en
 * una sola sentencia. Aqui no se decide nada de eso: esta funcion genera
 * credenciales, pregunta, y traduce un null a invalid_grant.
 */
import { ES_UUID, credencial, cuerpoDeFormulario, json, preflight, sha256Hex } from '../lib/http.ts'
import { ErrorDeRpc, llamarRpc } from '../lib/supabase-rpc.ts'
import { ALCANCE, origenDe, recursoAceptado } from '../../src/lib/mcp-conector.ts'

/** Una hora. Corto a proposito: un token filtrado deja de valer solo. */
const VIDA_DEL_TOKEN = 3600

function error(codigo: string, descripcion: string, estado = 400): Response {
  return json({ error: codigo, error_description: descripcion }, estado)
}

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' })
  }

  const campos = await cuerpoDeFormulario(request)
  const origen = origenDe(request.url)

  const clientId = campos.client_id ?? ''
  if (!ES_UUID.test(clientId)) {
    return error('invalid_client', 'Falta client_id o no tiene la forma de uno.', 401)
  }

  // El parametro resource es la atadura del token a este servidor y no a otro
  // (RFC 8707). Si llega, tiene que nombrar a este servidor.
  if (campos.resource !== undefined && !recursoAceptado(campos.resource, origen)) {
    return error('invalid_target', 'El parametro resource no nombra a este servidor MCP.')
  }

  const acceso = credencial()
  const renovacion = credencial()

  let resultado: unknown
  try {
    if (campos.grant_type === 'authorization_code') {
      if (!campos.code) return error('invalid_request', 'Falta code.')
      if (!campos.redirect_uri) return error('invalid_request', 'Falta redirect_uri.')
      if (!campos.code_verifier) return error('invalid_request', 'Falta code_verifier (PKCE).')

      resultado = await llamarRpc('mcp_exchange_authorization_code', {
        code: campos.code,
        client_id: clientId,
        redirect_uri: campos.redirect_uri,
        code_verifier: campos.code_verifier,
        access_token_hash: sha256Hex(acceso),
        refresh_token_hash: sha256Hex(renovacion),
        access_ttl_seconds: VIDA_DEL_TOKEN,
      })
    } else if (campos.grant_type === 'refresh_token') {
      if (!campos.refresh_token) return error('invalid_request', 'Falta refresh_token.')

      resultado = await llamarRpc('mcp_refresh_access_token', {
        refresh_token: campos.refresh_token,
        client_id: clientId,
        access_token_hash: sha256Hex(acceso),
        refresh_token_hash: sha256Hex(renovacion),
        access_ttl_seconds: VIDA_DEL_TOKEN,
      })
    } else {
      return error('unsupported_grant_type', 'Solo authorization_code y refresh_token.')
    }
  } catch (fallo) {
    if (fallo instanceof ErrorDeRpc && fallo.motivo === 'no_configurado') {
      return json({ error: 'server_error', error_description: 'server_not_configured' }, 500)
    }
    return json({ error: 'server_error' }, 502)
  }

  // Un solo invalid_grant para todo: codigo inexistente, caducado, ya usado,
  // de otro cliente, con otra redireccion, con un verificador que no casa,
  // refresh revocado o ya rotado. Distinguirlos seria contarle al que prueba
  // por donde va bien.
  if (resultado === null || typeof resultado !== 'object') {
    return error('invalid_grant', 'La concesion no es valida.')
  }

  const emitido = resultado as { expires_in?: unknown }

  return json({
    access_token: acceso,
    token_type: 'Bearer',
    expires_in: typeof emitido.expires_in === 'number' ? emitido.expires_in : VIDA_DEL_TOKEN,
    refresh_token: renovacion,
    scope: ALCANCE,
  })
}
