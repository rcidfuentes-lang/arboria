/**
 * El protocolo MCP de Arboria, sin HTTP.
 *
 * Aqui entra un mensaje JSON-RPC ya parseado y sale lo que hay que contestar.
 * El transporte —cabeceras, token, CORS, codigos de estado— esta en
 * netlify/functions/mcp.mts. La separacion no es estetica: permite ejercitar
 * todo el protocolo desde un script sin levantar nada.
 *
 * El servidor habla las dos eras del protocolo:
 *
 * - La legada (2025-03-26 a 2025-11-25) abre con initialize y negocia version
 *   en ese handshake.
 * - La moderna (2026-07-28) no tiene handshake: cada peticion declara su
 *   version en _meta y en la cabecera MCP-Protocol-Version, los resultados
 *   llevan resultType, y el descubrimiento es server/discover.
 *
 * Se hablan las dos porque no se sabe cual usa claude.ai hoy ni cual usara
 * dentro de seis meses, y porque un servidor que solo habla una se queda
 * mudo con la mitad de los clientes.
 *
 * No hay sesiones: ninguna respuesta asigna Mcp-Session-Id. Una funcion de
 * Netlify no tiene donde guardar una sesion, y el protocolo no la exige.
 */
import { stringifyRoadmapJson } from '../../src/lib/roadmap-document.ts'
import type { RoadmapDocument, RoadmapNode } from '../../src/types/roadmap'

export const VERSIONES_MODERNAS = ['2026-07-28']
export const VERSIONES_LEGADAS = ['2025-11-25', '2025-06-18', '2025-03-26']
export const VERSIONES = [...VERSIONES_MODERNAS, ...VERSIONES_LEGADAS]
export const VERSION_LEGADA_POR_DEFECTO = '2025-06-18'

export const CLAVE_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const CLAVE_IDENTIDAD = 'io.modelcontextprotocol/serverInfo'

export const IDENTIDAD = { name: 'arboria-roadmap', version: '1.0.0' }

export const INSTRUCCIONES =
  'Da acceso de solo lectura al roadmap de un proyecto de Arboria. La conexion ' +
  'esta atada a un unico proyecto: no hay forma de pedir otro ni de saber si ' +
  'existe. leer_roadmap devuelve el documento entero, identico a la exportacion ' +
  'de Arboria. leer_nodo devuelve una fase concreta con sus hijas, para no tener ' +
  'que traerse el documento entero cuando solo interesa una rama. Ninguna ' +
  'herramienta escribe.'

// Codigos que el protocolo reserva, ademas de los de JSON-RPC.
export const CODIGO_VERSION_NO_ADMITIDA = -32022
export const CODIGO_CABECERA_DISCORDANTE = -32020

export type Era = 'moderna' | 'legada'

export type MensajeJsonRpc = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

/**
 * El documento del proyecto, o la razon por la que no se ha podido preparar.
 * Un fallo aqui no impide conectar ni listar herramientas: solo hace que la
 * llamada a una herramienta conteste que no puede, con el motivo.
 */
export type Fuente = { documento: RoadmapDocument } | { fallo: string }

export type Contexto = {
  era: Era
  version: string
  fuente: Fuente
}

export type Salida =
  | { clase: 'mensaje'; estado: number; cuerpo: unknown }
  | { clase: 'sin_cuerpo'; estado: number }

const ESQUEMA_SIN_ARGUMENTOS = { type: 'object', additionalProperties: false }

export const HERRAMIENTAS = [
  {
    name: 'leer_roadmap',
    title: 'Leer el roadmap completo',
    description:
      'Devuelve el documento JSON completo del roadmap del proyecto al que da ' +
      'acceso esta conexion. Son exactamente los mismos bytes que produce el ' +
      'boton de exportar de Arboria: schemaVersion, project, ideas y el arbol ' +
      'de nodes, cada nodo con id, title, status, content e hijos.',
    inputSchema: ESQUEMA_SIN_ARGUMENTOS,
  },
  {
    name: 'leer_nodo',
    title: 'Leer una fase del roadmap',
    description:
      'Devuelve una fase del roadmap con todas sus fases hijas, tomada del ' +
      'mismo documento normalizado que devuelve leer_roadmap. El id es el del ' +
      'campo "id" del nodo, por ejemplo "SP" o "SP.3.1". Si no se sabe el id, ' +
      'llamar antes a leer_roadmap.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Id exacto del nodo, tal y como aparece en el documento.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

// --- Utilidades de mensaje ---------------------------------------------------

function sobre(id: unknown, resultado: Record<string, unknown>, era: Era) {
  // En la era moderna todo resultado declara de que tipo es. En la legada ese
  // campo no existe, asi que no se manda.
  const cuerpo = era === 'moderna' ? { resultType: 'complete', ...resultado } : resultado
  return { clase: 'mensaje' as const, estado: 200, cuerpo: { jsonrpc: '2.0', id, result: cuerpo } }
}

export function mensajeDeError(
  id: unknown,
  codigo: number,
  mensaje: string,
  datos?: unknown,
): { jsonrpc: '2.0'; id: unknown; error: Record<string, unknown> } {
  const error: Record<string, unknown> = { code: codigo, message: mensaje }
  if (datos !== undefined) error.data = datos
  return { jsonrpc: '2.0', id: id ?? null, error }
}

function fallo(id: unknown, codigo: number, mensaje: string, estado = 200, datos?: unknown): Salida {
  return { clase: 'mensaje', estado, cuerpo: mensajeDeError(id, codigo, mensaje, datos) }
}

export function errorDeVersion(id: unknown, pedida: unknown): Salida {
  return fallo(id, CODIGO_VERSION_NO_ADMITIDA, 'Unsupported protocol version', 400, {
    supported: VERSIONES,
    requested: pedida ?? null,
  })
}

export function errorDeCabecera(id: unknown, mensaje: string): Salida {
  return fallo(id, CODIGO_CABECERA_DISCORDANTE, mensaje, 400)
}

// --- Lectura del documento ---------------------------------------------------

function textoDeHerramienta(texto: string, era: Era, id: unknown, esError = false): Salida {
  return sobre(id, { content: [{ type: 'text', text: texto }], isError: esError }, era)
}

function buscarNodo(nodos: RoadmapNode[], id: string): RoadmapNode | null {
  for (const nodo of nodos) {
    if (nodo.id === id) return nodo
    const encontrado = buscarNodo(nodo.children, id)
    if (encontrado) return encontrado
  }
  return null
}

function idsDe(nodos: RoadmapNode[], acumulado: string[] = []): string[] {
  for (const nodo of nodos) {
    acumulado.push(nodo.id)
    idsDe(nodo.children, acumulado)
  }
  return acumulado
}

function ejecutar(nombre: unknown, argumentos: unknown, contexto: Contexto, id: unknown): Salida {
  if (nombre !== 'leer_roadmap' && nombre !== 'leer_nodo') {
    return fallo(id, -32602, `Unknown tool: ${String(nombre)}`)
  }

  if ('fallo' in contexto.fuente) {
    return textoDeHerramienta(contexto.fuente.fallo, contexto.era, id, true)
  }

  const documento = contexto.fuente.documento

  if (nombre === 'leer_roadmap') {
    // stringifyRoadmapJson es el mismo serializador que usa el boton de
    // exportar y /api/roadmap. Por eso esto es byte a byte la exportacion, y
    // no "un JSON equivalente".
    return textoDeHerramienta(stringifyRoadmapJson(documento), contexto.era, id)
  }

  const peticion = (argumentos && typeof argumentos === 'object' ? argumentos : {}) as {
    id?: unknown
  }
  const buscado = typeof peticion.id === 'string' ? peticion.id.trim() : ''
  if (!buscado) {
    return textoDeHerramienta(
      'Falta el argumento "id". Es el id de la fase, tal y como aparece en el ' +
        'documento que devuelve leer_roadmap.',
      contexto.era,
      id,
      true,
    )
  }

  const nodo = buscarNodo(documento.nodes, buscado)
  if (!nodo) {
    const disponibles = idsDe(documento.nodes)
    return textoDeHerramienta(
      `No hay ninguna fase con id "${buscado}" en este roadmap. Ids disponibles: ` +
        `${disponibles.join(', ') || '(el roadmap no tiene fases)'}.`,
      contexto.era,
      id,
      true,
    )
  }

  // El mismo serializador otra vez: lo que sale aqui es, caracter por caracter,
  // el fragmento correspondiente de la exportacion.
  return textoDeHerramienta(stringifyRoadmapJson(nodo), contexto.era, id)
}

// --- Despacho ----------------------------------------------------------------

export async function atender(mensaje: MensajeJsonRpc, contexto: Contexto): Promise<Salida> {
  const id = mensaje.id
  const metodo = mensaje.method
  const parametros = (mensaje.params && typeof mensaje.params === 'object'
    ? mensaje.params
    : {}) as Record<string, unknown>

  // Notificaciones: no llevan id y no se contestan con un cuerpo.
  if (typeof metodo === 'string' && metodo.startsWith('notifications/')) {
    return { clase: 'sin_cuerpo', estado: 202 }
  }

  if (metodo === 'initialize') {
    if (contexto.era !== 'legada') return fallo(id, -32601, 'Method not found: initialize', 404)
    const pedida = parametros.protocolVersion
    const version =
      typeof pedida === 'string' && VERSIONES_LEGADAS.includes(pedida)
        ? pedida
        : VERSION_LEGADA_POR_DEFECTO
    return sobre(
      id,
      {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: IDENTIDAD,
        instructions: INSTRUCCIONES,
      },
      'legada',
    )
  }

  if (metodo === 'server/discover') {
    if (contexto.era !== 'moderna') return fallo(id, -32601, 'Method not found: server/discover')
    return sobre(
      id,
      {
        supportedVersions: VERSIONES_MODERNAS,
        capabilities: { tools: {} },
        instructions: INSTRUCCIONES,
        _meta: { [CLAVE_IDENTIDAD]: IDENTIDAD },
      },
      'moderna',
    )
  }

  if (metodo === 'ping') return sobre(id, {}, contexto.era)

  if (metodo === 'tools/list') return sobre(id, { tools: HERRAMIENTAS }, contexto.era)

  if (metodo === 'tools/call') {
    return ejecutar(parametros.name, parametros.arguments, contexto, id)
  }

  // La era moderna pide que un metodo desconocido sea un 404 con el error de
  // JSON-RPC dentro, para que un cliente pueda distinguirlo de un 404 de un
  // servidor que no existe. La legada contesta 200 con el error.
  return fallo(
    id,
    -32601,
    `Method not found: ${String(metodo)}`,
    contexto.era === 'moderna' ? 404 : 200,
  )
}
