/**
 * Lo comun a los endpoints del conector: CORS, respuestas JSON, lectura de la
 * cabecera Authorization y generacion de credenciales.
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * Claude se conecta desde sus servidores, sin navegador, y ahi CORS no pinta
 * nada. Pero el inspector de MCP y cualquier cliente que corra en una pagina
 * si lo necesitan, y RFC 9728 pide que los metadatos se puedan leer desde un
 * navegador. Como todo lo que hay detras exige un token en una cabecera, abrir
 * CORS no concede nada por si solo.
 */
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'Access-Control-Expose-Headers': 'www-authenticate, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
}

export function json(cuerpo: unknown, estado = 200, extra: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(cuerpo)}\n`, {
    status: estado,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  })
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

export function bearerDe(request: Request): string | null {
  const cabecera = request.headers.get('Authorization')
  if (!cabecera) return null
  const [esquema, ...resto] = cabecera.split(' ')
  if (esquema.toLowerCase() !== 'bearer') return null
  const valor = resto.join(' ').trim()
  return valor || null
}

/**
 * 32 bytes de aleatoriedad criptografica, en base64url para que viajen en una
 * cabecera o en un formulario sin escapar nada. Es la misma receta que
 * scripts/generar-clave-de-lectura.mjs.
 */
export function credencial(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex')
}

export const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lee el cuerpo como formulario o como JSON, que es lo que mandan los clientes. */
export async function cuerpoDeFormulario(request: Request): Promise<Record<string, string>> {
  const tipo = request.headers.get('Content-Type') ?? ''
  const texto = await request.text()

  if (tipo.includes('application/json')) {
    try {
      const objeto = JSON.parse(texto) as Record<string, unknown>
      const campos: Record<string, string> = {}
      for (const [clave, valor] of Object.entries(objeto ?? {})) {
        if (typeof valor === 'string') campos[clave] = valor
      }
      return campos
    } catch {
      return {}
    }
  }

  const campos: Record<string, string> = {}
  for (const [clave, valor] of new URLSearchParams(texto)) campos[clave] = valor
  return campos
}
