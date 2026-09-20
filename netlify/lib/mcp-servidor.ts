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
import { stringifyDecisionesJson } from '../../src/lib/decisiones-document.ts'
import type { RoadmapDocument, RoadmapNode } from '../../src/types/roadmap'
import type { DecisionesDocument } from '../../src/types/decisiones'

export const VERSIONES_MODERNAS = ['2026-07-28']
export const VERSIONES_LEGADAS = ['2025-11-25', '2025-06-18', '2025-03-26']
export const VERSIONES = [...VERSIONES_MODERNAS, ...VERSIONES_LEGADAS]
export const VERSION_LEGADA_POR_DEFECTO = '2025-06-18'

export const CLAVE_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const CLAVE_IDENTIDAD = 'io.modelcontextprotocol/serverInfo'

export const IDENTIDAD = { name: 'arboria-roadmap', version: '1.0.0' }

export const INSTRUCCIONES =
  'Da acceso de solo lectura a un proyecto de Arboria: su roadmap y su decisor. ' +
  'La conexion esta atada a un unico proyecto: no hay forma de pedir otro ni de ' +
  'saber si existe. leer_roadmap devuelve el documento entero, identico a la ' +
  'exportacion de Arboria. leer_nodo devuelve una fase concreta con sus hijas, ' +
  'para no tener que traerse el documento entero cuando solo interesa una rama. ' +
  'leer_decisiones devuelve las decisiones que Ruben ha escrito en ese proyecto: ' +
  'que se decidio, cuando, por que, y si sigue vigente o la sustituyo otra. ' +
  'Ninguna herramienta escribe.'

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
 * Lo que se ha podido preparar de este proyecto, o la razon por la que no.
 * Un fallo aqui no impide conectar ni listar herramientas: solo hace que la
 * llamada a esa herramienta conteste que no puede, con el motivo.
 */
export type Recurso<T> = { valor: T } | { fallo: string }

/**
 * El roadmap viene ya resuelto porque comprobar el token y traerlo son la
 * misma consulta. Las decisiones vienen como una funcion y no como un valor a
 * proposito, por dos razones: una peticion que solo lista herramientas no
 * tiene por que ir a buscarlas, y un roadmap que no se puede normalizar no
 * debe arrastrar consigo a un decisor que si.
 */
export type Fuente = {
  roadmap: Recurso<RoadmapDocument>
  decisiones: () => Promise<Recurso<DecisionesDocument>>
}

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
  {
    name: 'leer_decisiones',
    title: 'Leer las decisiones del proyecto',
    description:
      'Devuelve las decisiones que Ruben ha escrito en este proyecto: que se ' +
      'decidio con sus palabras, la fecha en que se decidio, el motivo, el tema, ' +
      'donde esta el detalle y a que fase del roadmap toca, si toca a alguna. ' +
      'Cada decision esta activa o inactiva; una inactiva dice por que se quito y ' +
      'el numero de la que ocupa su sitio. Si se corrigio alguna vez, "correcciones" ' +
      'dice lo que decia antes. Sin argumentos devuelve todas, que es lo normal: ' +
      'son pocas. Los filtros son para cuando ya se sabe que se busca, y si no ' +
      'casa ninguna la lista vuelve vacia.',
    inputSchema: {
      type: 'object',
      properties: {
        numero: {
          type: 'integer',
          description: 'El numero de una decision concreta, si se sabe.',
        },
        tema: {
          type: 'string',
          description:
            'Filtra por tema. No distingue mayusculas. Los temas los pone Ruben al ' +
            'escribir cada decision; para saber cuales hay, llamar sin filtros.',
        },
        estado: {
          type: 'string',
          enum: ['activa', 'inactiva', 'todas'],
          description:
            'Por defecto "todas". Una decision inactiva sigue explicando por que se ' +
            'hizo lo que se hizo, asi que no se esconde salvo que se pida.',
        },
      },
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

async function ejecutar(
  nombre: unknown,
  argumentos: unknown,
  contexto: Contexto,
  id: unknown,
): Promise<Salida> {
  if (nombre === 'leer_decisiones') {
    return decisiones(argumentos, contexto, id)
  }

  if (nombre !== 'leer_roadmap' && nombre !== 'leer_nodo') {
    return fallo(id, -32602, `Unknown tool: ${String(nombre)}`)
  }

  if ('fallo' in contexto.fuente.roadmap) {
    return textoDeHerramienta(contexto.fuente.roadmap.fallo, contexto.era, id, true)
  }

  const documento = contexto.fuente.roadmap.valor

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

/**
 * Las decisiones, con los filtros aplicados sobre el documento ya normalizado.
 *
 * Se filtra aqui y no en la base porque la base ya ha hecho lo unico que no se
 * puede hacer en otro sitio, que es decidir de que proyecto son. Un filtro por
 * tema es una comodidad de lectura, no una frontera de permisos, y hacerlo
 * aqui deja una sola consulta y una sola forma de documento.
 */
async function decisiones(argumentos: unknown, contexto: Contexto, id: unknown): Promise<Salida> {
  const fuente = await contexto.fuente.decisiones()
  if ('fallo' in fuente) {
    return textoDeHerramienta(fuente.fallo, contexto.era, id, true)
  }

  const peticion = (argumentos && typeof argumentos === 'object' ? argumentos : {}) as {
    numero?: unknown
    tema?: unknown
    estado?: unknown
  }

  const estado = typeof peticion.estado === 'string' ? peticion.estado : 'todas'
  if (estado !== 'todas' && estado !== 'activa' && estado !== 'inactiva') {
    return textoDeHerramienta(
      'El argumento "estado" solo admite "activa", "inactiva" o "todas".',
      contexto.era,
      id,
      true,
    )
  }

  const tema = typeof peticion.tema === 'string' ? peticion.tema.trim().toLowerCase() : ''
  const numero = typeof peticion.numero === 'number' ? peticion.numero : null

  const documento = fuente.valor
  const filtradas = documento.decisiones.filter((decision) => {
    if (numero !== null && decision.numero !== numero) return false
    if (tema && decision.tema.toLowerCase() !== tema) return false
    if (estado !== 'todas' && decision.estado !== estado) return false
    return true
  })

  return textoDeHerramienta(
    stringifyDecisionesJson({ ...documento, decisiones: filtradas }),
    contexto.era,
    id,
  )
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
    return await ejecutar(parametros.name, parametros.arguments, contexto, id)
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
