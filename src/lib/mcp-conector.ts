/**
 * Lo que comparten la pantalla de autorizacion de la aplicacion y los
 * endpoints del conector: las rutas, la identidad del recurso y los dos
 * documentos de descubrimiento.
 *
 * Esta aqui y no en netlify/lib porque la pantalla de autorizacion vive en la
 * aplicacion. Por eso tampoco importa nada de Node: lo compila tambien Vite.
 *
 * Nada de esto esta escrito a mano en un fichero de configuracion: el origen
 * sale de la peticion que llega. Asi el conector funciona igual en
 * arboria.rubenstuff.es, en un despliegue de prueba de Netlify y en local, sin
 * que haya una direccion que actualizar en dos sitios.
 */

export const RUTA_MCP = '/mcp'
export const RUTA_AUTORIZAR = '/oauth/autorizar'
export const RUTA_TOKEN = '/oauth/token'
export const RUTA_REGISTRO = '/oauth/registro'
export const RUTA_METADATOS_SERVIDOR = '/.well-known/oauth-authorization-server'
export const RUTA_METADATOS_RECURSO = '/.well-known/oauth-protected-resource'

/** Un solo alcance, y de solo lectura. No hay ningun otro que conceder. */
export const ALCANCE = 'roadmap:leer'

export function origenDe(url: string): string {
  const direccion = new URL(url)
  return `${direccion.protocol}//${direccion.host}`
}

/**
 * El identificador canonico del servidor MCP, que es lo que el cliente manda
 * en el parametro resource y a lo que queda atado el token (RFC 8707).
 */
export function recursoCanonico(origen: string): string {
  return `${origen}${RUTA_MCP}`
}

/**
 * Se acepta la forma canonica y las dos variantes que un cliente razonable
 * puede mandar: con barra final, y el origen a secas. La especificacion pide
 * la mas concreta pero admite el origen, y rechazar por una barra seria
 * dejar el conector sin conectar por un detalle de escritura.
 *
 * Cualquier otra cosa se rechaza: ahi esta la validacion de audiencia que
 * impide que un token emitido para otro servicio valga aqui.
 */
export function recursoAceptado(valor: string | null, origen: string): boolean {
  if (!valor) return false
  let normalizado: string
  try {
    const direccion = new URL(valor)
    if (direccion.hash || direccion.search) return false
    const ruta = direccion.pathname.replace(/\/+$/, '')
    normalizado = `${direccion.protocol}//${direccion.host}${ruta}`.toLowerCase()
  } catch {
    return false
  }
  return normalizado === origen.toLowerCase() || normalizado === recursoCanonico(origen).toLowerCase()
}

/**
 * Metadatos del recurso protegido (RFC 9728). Es el documento que el cliente
 * busca cuando el servidor MCP le contesta 401, y lo unico que dice es donde
 * esta el servidor de autorizacion.
 */
export function metadatosDelRecurso(origen: string) {
  return {
    resource: recursoCanonico(origen),
    authorization_servers: [origen],
    scopes_supported: [ALCANCE],
    bearer_methods_supported: ['header'],
    resource_name: 'Roadmap de Arboria',
    resource_documentation: `${origen}/`,
  }
}

/**
 * Metadatos del servidor de autorizacion (RFC 8414).
 *
 * - token_endpoint_auth_methods_supported es solo "none" porque los clientes
 *   son publicos: no hay secreto que puedan guardar. Lo que protege el codigo
 *   es PKCE.
 * - code_challenge_methods_supported es solo S256. "plain" no protege nada.
 * - authorization_response_iss_parameter_supported va en true porque la
 *   pantalla de autorizacion devuelve iss en la redireccion (RFC 9207), y
 *   declararlo es lo que permite al cliente exigirlo.
 * - client_id_metadata_document_supported va en false y dicho a proposito: la
 *   especificacion de 2026 prefiere ese mecanismo al registro dinamico, pero
 *   implicaria que Arboria descargue un documento de una URL que elige quien
 *   llama. Aqui se queda con el registro dinamico, que sigue admitido.
 */
export function metadatosDelServidor(origen: string) {
  return {
    issuer: origen,
    authorization_endpoint: `${origen}${RUTA_AUTORIZAR}`,
    token_endpoint: `${origen}${RUTA_TOKEN}`,
    registration_endpoint: `${origen}${RUTA_REGISTRO}`,
    scopes_supported: [ALCANCE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origen}/`,
  }
}
