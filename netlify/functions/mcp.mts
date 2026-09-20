/**
 * Servidor MCP remoto de Arboria, por Streamable HTTP.
 *
 * POST /mcp
 * Authorization: Bearer <token de acceso emitido por /oauth/token>
 *
 * Solo lectura. Las dos herramientas leen; no hay ninguna que escriba, ni
 * ninguna ruta aqui que escriba nada. El token no puede hacer otra cosa
 * porque no existe otra cosa que hacer.
 *
 * El token esta atado a un proyecto. La peticion no lleva identificador de
 * proyecto y no hay forma de pedir otro: quien autoriza el conector para
 * Songplay lee Songplay, y de cualquier otro proyecto no sabe ni si existe.
 *
 * Se contesta siempre con un unico objeto JSON, nunca con un flujo SSE. El
 * protocolo lo permite explicitamente, y las dos herramientas devuelven de
 * golpe algo que ya esta en memoria: no hay nada que ir emitiendo. Ademas una
 * funcion de Netlify no es el sitio para sostener una conexion abierta.
 *
 * Tampoco hay sesiones: ninguna respuesta asigna Mcp-Session-Id, asi que cada
 * peticion se basta sola. Es lo que pide la revision de 2026 y lo que la
 * anterior permite.
 */
import { CORS, bearerDe, json, preflight } from '../lib/http.ts'
import { ErrorDeLectura, documentoDesdeRpc } from '../lib/roadmap-lectura.ts'
import { RichTextUnavailableError } from '../../src/lib/roadmap-document.ts'
import {
  ALCANCE,
  RUTA_METADATOS_RECURSO,
  origenDe,
} from '../../src/lib/mcp-conector.ts'
import {
  CLAVE_VERSION,
  VERSIONES,
  VERSIONES_MODERNAS,
  atender,
  errorDeCabecera,
  errorDeVersion,
  mensajeDeError,
} from '../lib/mcp-servidor.ts'
import type { Era, Fuente, Salida } from '../lib/mcp-servidor.ts'

/**
 * Origenes de navegador admitidos. La especificacion obliga a validar Origin
 * para que una pagina cualquiera no pueda hablar con el servidor desde el
 * navegador de quien la visita.
 *
 * Claude se conecta desde sus servidores y no manda Origin, asi que en la
 * practica esto no le afecta; la lista existe por el inspector de MCP y por
 * cualquier cliente que corra en una pagina. Una peticion sin Origin no se
 * rechaza: no viene de un navegador.
 */
function origenPermitido(origen: string, propio: string): boolean {
  if (origen === propio) return true
  let direccion: URL
  try {
    direccion = new URL(origen)
  } catch {
    return false
  }
  const host = direccion.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true
  return (
    host === 'claude.ai' ||
    host.endsWith('.claude.ai') ||
    host === 'claude.com' ||
    host.endsWith('.claude.com')
  )
}

function reto(origen: string, extra = ''): string {
  return `Bearer resource_metadata="${origen}${RUTA_METADATOS_RECURSO}", scope="${ALCANCE}"${extra}`
}

function sinAutorizar(origen: string, motivo: string | null): Response {
  const extra = motivo ? `, error="${motivo}"` : ''
  return json(mensajeDeError(null, -32001, 'Unauthorized'), 401, {
    'WWW-Authenticate': reto(origen, extra),
  })
}

/** Las cabeceras pueden traer el valor en base64 cuando no cabe en ASCII. */
function descifrarCabecera(valor: string | null): string | null {
  if (valor === null) return null
  if (!valor.startsWith('=?base64?') || !valor.endsWith('?=')) return valor
  try {
    return Buffer.from(valor.slice(9, -2), 'base64').toString('utf8')
  } catch {
    return valor
  }
}

function responder(salida: Salida, version: string): Response {
  if (salida.clase === 'sin_cuerpo') {
    return new Response(null, {
      status: salida.estado,
      headers: { ...CORS, 'MCP-Protocol-Version': version },
    })
  }
  return json(salida.cuerpo, salida.estado, { 'MCP-Protocol-Version': version })
}

export default async (request: Request): Promise<Response> => {
  const origen = origenDe(request.url)

  if (request.method === 'OPTIONS') return preflight()

  // GET abria el flujo SSE de la revision antigua y DELETE cerraba la sesion.
  // Aqui no hay ni una cosa ni la otra, y 405 es exactamente lo que el
  // protocolo manda contestar.
  if (request.method !== 'POST') {
    return json(mensajeDeError(null, -32600, 'Method Not Allowed'), 405, {
      Allow: 'POST, OPTIONS',
    })
  }

  const origenDelNavegador = request.headers.get('Origin')
  if (origenDelNavegador && !origenPermitido(origenDelNavegador, origen)) {
    return json(mensajeDeError(null, -32600, 'Forbidden origin'), 403)
  }

  const token = bearerDe(request)
  if (!token) return sinAutorizar(origen, null)

  // Comprobar el token y traer el documento son la misma consulta: la funcion
  // de la base devuelve el documento del proyecto al que apunta el token, o
  // null. No hay forma de preguntar una cosa sin la otra, y es a proposito.
  let fuente: Fuente
  try {
    fuente = { documento: await documentoDesdeRpc('mcp_document_by_access_token', {
      access_token: token,
    }) }
  } catch (error) {
    if (error instanceof ErrorDeLectura && error.codigo === 'unauthorized') {
      return sinAutorizar(origen, 'invalid_token')
    }
    if (
      error instanceof ErrorDeLectura &&
      (error.codigo === 'roadmap_lookup_failed' || error.codigo === 'server_not_configured')
    ) {
      // No se ha podido comprobar el token, asi que no se da por bueno. Esto
      // no es una respuesta del protocolo: es que el servidor no esta en
      // condiciones de contestar.
      return json(mensajeDeError(null, -32603, 'Roadmap lookup failed'), 502)
    }
    // El token era bueno —la base devolvio un documento— pero el documento no
    // se puede servir. Conectar y listar herramientas funciona; lo que falla
    // es llamarlas, y con el motivo dicho.
    if (error instanceof RichTextUnavailableError) {
      fuente = {
        fallo:
          'Este roadmap tiene ideas con contenido, y sanearlas necesita un DOM ' +
          'que aqui no hay. Se falla en alto en vez de devolver unos bytes ' +
          'distintos de los que produce la exportacion de Arboria.',
      }
    } else if (error instanceof ErrorDeLectura && error.codigo === 'invalid_roadmap_document') {
      fuente = { fallo: 'Lo guardado para este proyecto no tiene la forma de un roadmap.' }
    } else {
      fuente = { fallo: 'No se ha podido normalizar el roadmap de este proyecto.' }
    }
  }

  let mensaje: unknown
  try {
    mensaje = await request.json()
  } catch {
    return json(mensajeDeError(null, -32700, 'Parse error'), 400)
  }

  if (Array.isArray(mensaje)) {
    return json(mensajeDeError(null, -32600, 'Batched requests are not supported'), 400)
  }
  if (!mensaje || typeof mensaje !== 'object') {
    return json(mensajeDeError(null, -32600, 'Invalid Request'), 400)
  }

  const peticion = mensaje as { id?: unknown; method?: unknown; params?: unknown }
  const parametros = (peticion.params && typeof peticion.params === 'object'
    ? peticion.params
    : {}) as Record<string, unknown>
  const meta = (parametros._meta && typeof parametros._meta === 'object'
    ? parametros._meta
    : {}) as Record<string, unknown>

  const versionEnCuerpo = typeof meta[CLAVE_VERSION] === 'string' ? (meta[CLAVE_VERSION] as string) : null
  const versionEnCabecera = request.headers.get('MCP-Protocol-Version')

  // Como se distingue una era de otra: la moderna declara la version dentro de
  // _meta. Si no hay _meta pero la cabecera anuncia una version moderna, se la
  // trata como moderna igual. Todo lo demas es la era del handshake.
  const era: Era =
    versionEnCuerpo !== null || (versionEnCabecera && VERSIONES_MODERNAS.includes(versionEnCabecera))
      ? 'moderna'
      : 'legada'

  if (era === 'moderna') {
    const version = versionEnCuerpo ?? versionEnCabecera ?? ''
    if (!VERSIONES_MODERNAS.includes(version)) {
      return responder(errorDeVersion(peticion.id, version || null), version || VERSIONES[0])
    }
    if (versionEnCabecera === null) {
      return responder(
        errorDeCabecera(peticion.id, 'Falta la cabecera MCP-Protocol-Version.'),
        version,
      )
    }
    if (versionEnCuerpo !== null && versionEnCabecera !== versionEnCuerpo) {
      return responder(
        errorDeCabecera(
          peticion.id,
          'La cabecera MCP-Protocol-Version no coincide con _meta del cuerpo.',
        ),
        version,
      )
    }

    const metodoEnCabecera = request.headers.get('Mcp-Method')
    if (metodoEnCabecera === null) {
      return responder(errorDeCabecera(peticion.id, 'Falta la cabecera Mcp-Method.'), version)
    }
    if (metodoEnCabecera !== peticion.method) {
      return responder(
        errorDeCabecera(peticion.id, 'La cabecera Mcp-Method no coincide con el cuerpo.'),
        version,
      )
    }

    if (peticion.method === 'tools/call') {
      const nombreEnCabecera = descifrarCabecera(request.headers.get('Mcp-Name'))
      if (nombreEnCabecera === null) {
        return responder(errorDeCabecera(peticion.id, 'Falta la cabecera Mcp-Name.'), version)
      }
      if (nombreEnCabecera !== parametros.name) {
        return responder(
          errorDeCabecera(peticion.id, 'La cabecera Mcp-Name no coincide con el cuerpo.'),
          version,
        )
      }
    }

    return responder(await atender(peticion, { era, version, fuente }), version)
  }

  // Era legada. Sin cabecera se asume la primera version que la definio, que
  // es lo que dice la especificacion para clientes viejos.
  const version = versionEnCabecera ?? '2025-03-26'
  if (!VERSIONES.includes(version)) {
    return responder(errorDeVersion(peticion.id, version), version)
  }

  return responder(await atender(peticion, { era, version, fuente }), version)
}
