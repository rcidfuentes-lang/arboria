#!/usr/bin/env node
/**
 * Comprueba el conector MCP entero sin desplegar y sin tocar Supabase.
 *
 *   node scripts/verificar-mcp.mjs [fichero-exportado.json ...]
 *
 * Simula las seis funciones de la base —incluyendo que Postgres reordena las
 * claves de todo objeto jsonb por longitud y luego por bytes— y llama a los
 * endpoints reales: descubrimiento, registro, token y /mcp. Las credenciales
 * son de usar y tirar: se generan aqui, no salen del proceso y no llegan a
 * ninguna base.
 *
 * Con un fichero por argumento comprueba lo que de verdad importa: que
 * leer_roadmap devuelve byte a byte ese fichero, y que devuelve exactamente lo
 * mismo que /api/roadmap para el mismo documento.
 *
 * Lo que esto NO comprueba es el SQL: la simulacion es una lectura fiel de la
 * migracion, no la migracion. El SQL se verifica aplicandolo y probando contra
 * el sitio desplegado.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  normalizeRoadmapDocument,
  stringifyRoadmapJson,
} from '../src/lib/roadmap-document.ts'

const ORIGEN = 'https://arboria.ejemplo'
const RECURSO = `${ORIGEN}/mcp`

const sha = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex')
const base64url = (bytes) => Buffer.from(bytes).toString('base64url')
const retoDe = (verificador) =>
  createHash('sha256').update(verificador, 'utf8').digest('base64url')

/** Como guarda Postgres un jsonb: claves por longitud y, a igual longitud, por bytes. */
function comoJsonb(valor) {
  if (Array.isArray(valor)) return valor.map(comoJsonb)
  if (valor && typeof valor === 'object') {
    const orden = Object.keys(valor).sort(
      (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    )
    return Object.fromEntries(orden.map((clave) => [clave, comoJsonb(valor[clave])]))
  }
  return valor
}

// --- Documentos de prueba ----------------------------------------------------

const SONGPLAY = {
  schemaVersion: 1,
  project: { id: 'songplay', name: 'Songplay' },
  ideas: [],
  nodes: [
    {
      id: 'SP',
      title: 'Songplay',
      status: 'planned',
      content: 'Raiz del proyecto. Acentos: cañón, ó, —.',
      children: [
        { id: 'SP.1', title: 'Sala de Despiece', status: 'closed', content: '', children: [] },
        { id: 'SP.2', title: 'La Forja', status: 'in_progress', content: '', children: [] },
        { id: 'SP.3', title: 'Guitar Play', status: 'planned', content: '', children: [] },
      ],
    },
  ],
}

const OTRO = {
  schemaVersion: 1,
  project: { id: 'otro-proyecto', name: 'Otro proyecto' },
  ideas: [],
  nodes: [{ id: 'OP1', title: 'Fase del otro', status: 'planned', content: '', children: [] }],
}

// --- Base simulada -----------------------------------------------------------

let AHORA = Date.UTC(2026, 8, 20, 12, 0, 0)
const avanzar = (segundos) => {
  AHORA += segundos * 1000
}

const proyectos = new Map() // project_id -> { documento, owner_id }
const clientes = new Map() // client_id -> { client_name, redirect_uris, created_at }
const codigos = new Map() // code_hash -> fila
const tokens = [] // filas
const clavesDeLectura = new Map() // key_hash -> project_id

const RUBEN = randomUUID()
const PROYECTO_SONGPLAY = randomUUID()
const PROYECTO_OTRO = randomUUID()
proyectos.set(PROYECTO_SONGPLAY, { documento: SONGPLAY, owner_id: RUBEN })
proyectos.set(PROYECTO_OTRO, { documento: OTRO, owner_id: RUBEN })

const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mcp_register_client({ client_name, redirect_uris }) {
  if (!client_name || !client_name.trim()) return null
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.length > 10) {
    return null
  }
  for (const uri of redirect_uris) {
    if (typeof uri !== 'string' || uri.length > 2000 || uri.includes('#')) return null
    const admitida =
      uri.startsWith('https://') ||
      /^http:\/\/localhost(\/|:|$)/.test(uri) ||
      /^http:\/\/127\.0\.0\.1(\/|:|$)/.test(uri)
    if (!admitida) return null
  }
  const recientes = [...clientes.values()].filter((c) => c.created_at > AHORA - 3600_000)
  if (recientes.length >= 20) return null

  const client_id = randomUUID()
  clientes.set(client_id, {
    client_name: client_name.slice(0, 200),
    redirect_uris,
    created_at: AHORA,
  })
  return {
    client_id,
    client_id_issued_at: Math.floor(AHORA / 1000),
    client_name: client_name.slice(0, 200),
    redirect_uris,
  }
}

function mcp_client_for_authorization({ client_id, redirect_uri }) {
  const cliente = clientes.get(client_id)
  if (!cliente || !cliente.redirect_uris.includes(redirect_uri)) return null
  return { client_name: cliente.client_name }
}

function mcp_issue_authorization_code(argumentos, usuario) {
  const { client_id, project_id, redirect_uri, code_challenge, resource, code_hash } = argumentos
  if (!usuario) return false
  if (!/^[A-Za-z0-9_-]{43}$/.test(code_challenge ?? '')) return false
  if (!/^[0-9a-f]{64}$/.test(code_hash ?? '')) return false
  if (!resource || !resource.trim()) return false

  const proyecto = proyectos.get(project_id)
  if (!proyecto || proyecto.owner_id !== usuario) return false

  const cliente = clientes.get(client_id)
  if (!cliente || !cliente.redirect_uris.includes(redirect_uri)) return false

  codigos.set(code_hash, {
    code_hash,
    client_id,
    project_id,
    owner_id: usuario,
    redirect_uri,
    code_challenge,
    resource,
    expires_at: AHORA + 5 * 60_000,
    consumed_at: null,
  })
  return true
}

function mcp_exchange_authorization_code(argumentos) {
  const {
    code,
    client_id,
    redirect_uri,
    code_verifier,
    access_token_hash,
    refresh_token_hash,
    access_ttl_seconds,
  } = argumentos

  if (!code || !code_verifier) return null
  if (!/^[0-9a-f]{64}$/.test(access_token_hash ?? '')) return null
  if (!/^[0-9a-f]{64}$/.test(refresh_token_hash ?? '')) return null
  if (!(access_ttl_seconds >= 60 && access_ttl_seconds <= 86400)) return null
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) return null

  const hash = sha(code)
  const fila = codigos.get(hash)
  const vale =
    fila &&
    fila.consumed_at === null &&
    fila.expires_at > AHORA &&
    fila.client_id === client_id &&
    fila.redirect_uri === redirect_uri &&
    fila.code_challenge === retoDe(code_verifier)

  if (!vale) {
    // Codigo presentado dos veces: se revoca lo que se emitio con el.
    for (const token of tokens) {
      if (token.code_hash === hash && token.revoked_at === null) token.revoked_at = AHORA
    }
    return null
  }

  fila.consumed_at = AHORA
  tokens.push({
    id: randomUUID(),
    chain_id: randomUUID(),
    code_hash: fila.code_hash,
    client_id: fila.client_id,
    project_id: fila.project_id,
    owner_id: fila.owner_id,
    resource: fila.resource,
    access_token_hash,
    refresh_token_hash,
    access_expires_at: AHORA + access_ttl_seconds * 1000,
    refresh_expires_at: AHORA + 90 * 24 * 3600_000,
    rotated_at: null,
    revoked_at: null,
  })
  return { expires_in: access_ttl_seconds, resource: fila.resource }
}

function mcp_refresh_access_token(argumentos) {
  const { refresh_token, client_id, access_token_hash, refresh_token_hash, access_ttl_seconds } =
    argumentos
  if (!refresh_token) return null
  if (!/^[0-9a-f]{64}$/.test(access_token_hash ?? '')) return null
  if (!/^[0-9a-f]{64}$/.test(refresh_token_hash ?? '')) return null
  if (!(access_ttl_seconds >= 60 && access_ttl_seconds <= 86400)) return null

  const hash = sha(refresh_token)
  const viejo = tokens.find((t) => t.refresh_token_hash === hash && t.client_id === client_id)
  if (!viejo) return null

  if (viejo.rotated_at !== null) {
    // Reutilizacion de un refresh ya rotado: se revoca la cadena entera.
    for (const token of tokens) {
      if (token.chain_id === viejo.chain_id && token.revoked_at === null) token.revoked_at = AHORA
    }
    return null
  }
  if (viejo.revoked_at !== null) return null
  if (viejo.refresh_expires_at <= AHORA) return null

  viejo.rotated_at = AHORA
  viejo.revoked_at = AHORA
  tokens.push({
    id: randomUUID(),
    chain_id: viejo.chain_id,
    code_hash: viejo.code_hash,
    client_id: viejo.client_id,
    project_id: viejo.project_id,
    owner_id: viejo.owner_id,
    resource: viejo.resource,
    access_token_hash,
    refresh_token_hash,
    access_expires_at: AHORA + access_ttl_seconds * 1000,
    refresh_expires_at: viejo.refresh_expires_at,
    rotated_at: null,
    revoked_at: null,
  })
  return { expires_in: access_ttl_seconds, resource: viejo.resource }
}

function mcp_document_by_access_token({ access_token }) {
  const hash = sha(access_token ?? '')
  const fila = tokens.find(
    (t) => t.access_token_hash === hash && t.revoked_at === null && t.access_expires_at > AHORA,
  )
  if (!fila) return null
  const proyecto = proyectos.get(fila.project_id)
  if (!proyecto) return null
  return comoJsonb(proyecto.documento)
}

function roadmap_document_by_key({ api_key }) {
  const project_id = clavesDeLectura.get(sha(api_key ?? ''))
  if (!project_id) return null
  return comoJsonb(proyectos.get(project_id).documento)
}

const FUNCIONES = {
  mcp_register_client,
  mcp_exchange_authorization_code,
  mcp_refresh_access_token,
  mcp_document_by_access_token,
  roadmap_document_by_key,
}

let rpcLlamadas = []
globalThis.fetch = async (url, init) => {
  const ruta = String(url)
  const marca = '/rest/v1/rpc/'
  if (!ruta.includes(marca)) throw new Error(`ruta inesperada: ${ruta}`)
  const nombre = ruta.slice(ruta.indexOf(marca) + marca.length)
  const funcion = FUNCIONES[nombre]
  if (!funcion) throw new Error(`funcion inesperada desde un endpoint publico: ${nombre}`)
  rpcLlamadas.push(nombre)
  return new Response(JSON.stringify(funcion(JSON.parse(init.body))), { status: 200 })
}

process.env.SUPABASE_URL = 'https://ejemplo.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'clave-anonima-de-prueba'

// --- Endpoints reales --------------------------------------------------------

const cargar = async (fichero) =>
  (await import(pathToFileURL(new URL(`../netlify/functions/${fichero}`, import.meta.url).pathname).href))
    .default

const endpointRecurso = await cargar('oauth-recurso.mts')
const endpointMetadatos = await cargar('oauth-metadatos.mts')
const endpointRegistro = await cargar('oauth-registro.mts')
const endpointToken = await cargar('oauth-token.mts')
const endpointMcp = await cargar('mcp.mts')
const endpointRoadmap = await cargar('roadmap.mts')

const { HERRAMIENTAS } = await import(
  pathToFileURL(new URL('../netlify/lib/mcp-servidor.ts', import.meta.url).pathname).href
)

// --- Comprobaciones ----------------------------------------------------------

let fallos = 0
function comprobar(etiqueta, condicion, detalle = '') {
  if (!condicion) fallos += 1
  console.log(`${condicion ? '  ok  ' : ' MAL  '} ${etiqueta}${detalle ? `  ->  ${detalle}` : ''}`)
}

const pedirMcp = (opciones = {}) => {
  const cabeceras = {}
  if (opciones.token !== undefined) cabeceras.Authorization = `Bearer ${opciones.token}`
  if (opciones.origen) cabeceras.Origin = opciones.origen
  Object.assign(cabeceras, opciones.cabeceras ?? {})
  return endpointMcp(
    new Request(RECURSO, {
      method: opciones.metodo ?? 'POST',
      headers: cabeceras,
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    }),
  )
}

const legado = (metodo, params, id = 1) => ({
  cabeceras: { 'MCP-Protocol-Version': '2025-06-18', 'Content-Type': 'application/json' },
  cuerpo: { jsonrpc: '2.0', id, method: metodo, params },
})

const moderno = (metodo, params, id = 1) => {
  const cabeceras = {
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': metodo,
    'Content-Type': 'application/json',
  }
  if (metodo === 'tools/call') cabeceras['Mcp-Name'] = params.name
  return {
    cabeceras,
    cuerpo: {
      jsonrpc: '2.0',
      id,
      method: metodo,
      params: {
        ...params,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    },
  }
}

const formulario = (campos) =>
  endpointToken(
    new Request(`${ORIGEN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(campos).toString(),
    }),
  )

console.log('\nDescubrimiento')
{
  const recurso = await endpointRecurso(
    new Request(`${ORIGEN}/.well-known/oauth-protected-resource`),
  )
  const metadatos = await recurso.json()
  comprobar('el recurso se identifica como el endpoint MCP', metadatos.resource === RECURSO, metadatos.resource)
  comprobar(
    'y apunta a Arboria como servidor de autorizacion',
    JSON.stringify(metadatos.authorization_servers) === JSON.stringify([ORIGEN]),
  )

  const servidor = await (await endpointMetadatos(
    new Request(`${ORIGEN}/.well-known/oauth-authorization-server`),
  )).json()
  comprobar('emisor igual al origen', servidor.issuer === ORIGEN)
  comprobar(
    'solo PKCE S256',
    JSON.stringify(servidor.code_challenge_methods_supported) === JSON.stringify(['S256']),
  )
  comprobar(
    'solo clientes publicos',
    JSON.stringify(servidor.token_endpoint_auth_methods_supported) === JSON.stringify(['none']),
  )
  comprobar(
    'solo authorization_code y refresh_token',
    JSON.stringify(servidor.grant_types_supported) ===
      JSON.stringify(['authorization_code', 'refresh_token']),
  )
  comprobar('registro dinamico anunciado', servidor.registration_endpoint === `${ORIGEN}/oauth/registro`)
}

console.log('\nSin token no se entra')
{
  const respuesta = await pedirMcp(legado('initialize', {}))
  const reto = respuesta.headers.get('WWW-Authenticate') ?? ''
  comprobar('401 sin cabecera Authorization', respuesta.status === 401, String(respuesta.status))
  comprobar(
    'y el reto dice donde estan los metadatos del recurso',
    reto.includes(`resource_metadata="${ORIGEN}/.well-known/oauth-protected-resource"`) &&
      reto.includes('scope="roadmap:leer"'),
    reto,
  )
}
for (const metodo of ['GET', 'DELETE', 'PUT']) {
  const respuesta = await pedirMcp({ metodo, token: 'lo-que-sea' })
  comprobar(`${metodo} /mcp: 405`, respuesta.status === 405, String(respuesta.status))
}

console.log('\nRegistro dinamico de clientes')
let CLIENTE = null
const RETORNO = 'https://claude.ai/api/mcp/auth_callback'
{
  const respuesta = await endpointRegistro(
    new Request(`${ORIGEN}/oauth/registro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [RETORNO, 'https://claude.com/api/mcp/auth_callback'],
      }),
    }),
  )
  CLIENTE = await respuesta.json()
  comprobar('alta correcta: 201', respuesta.status === 201, String(respuesta.status))
  comprobar('devuelve un client_id', ES_UUID.test(CLIENTE.client_id ?? ''), String(CLIENTE.client_id))
  comprobar('sin secreto de cliente', CLIENTE.client_secret === undefined)
  comprobar('autenticacion de cliente: none', CLIENTE.token_endpoint_auth_method === 'none')

  const mala = await endpointRegistro(
    new Request(`${ORIGEN}/oauth/registro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: ['http://ejemplo.invalido/vuelta'] }),
    }),
  )
  comprobar('redireccion http que no es localhost: rechazada', mala.status === 400, String(mala.status))
}

/** Lo que hace la pantalla de autorizacion en el navegador de Ruben. */
async function autorizar({ proyecto = PROYECTO_SONGPLAY, cliente = CLIENTE.client_id, retorno = RETORNO, usuario = RUBEN } = {}) {
  const verificador = base64url(randomBytes(32))
  const codigo = base64url(randomBytes(32))
  const concedido = mcp_issue_authorization_code(
    {
      client_id: cliente,
      project_id: proyecto,
      redirect_uri: retorno,
      code_challenge: retoDe(verificador),
      resource: RECURSO,
      code_hash: sha(codigo),
    },
    usuario,
  )
  return { codigo, verificador, concedido }
}

console.log('\nAutorizacion: solo el dueño, y solo su proyecto')
{
  const ajeno = await autorizar({ usuario: randomUUID() })
  comprobar('otro usuario no puede conceder este proyecto', ajeno.concedido === false)

  const sinSesion = await autorizar({ usuario: null })
  comprobar('sin sesion no se concede nada', sinSesion.concedido === false)

  const retornoAjeno = await autorizar({ retorno: 'https://sitio.invalido/vuelta' })
  comprobar('una redireccion no registrada no se concede', retornoAjeno.concedido === false)

  const preparar = mcp_client_for_authorization({
    client_id: CLIENTE.client_id,
    redirect_uri: 'https://sitio.invalido/vuelta',
  })
  comprobar('y la pantalla no llega ni a ofrecerla', preparar === null)
}

console.log('\nCanje del codigo')
let ACCESO = null
let RENOVACION = null
{
  const { codigo, verificador } = await autorizar()

  const malVerificador = await formulario({
    grant_type: 'authorization_code',
    code: codigo,
    client_id: CLIENTE.client_id,
    redirect_uri: RETORNO,
    code_verifier: base64url(randomBytes(32)),
    resource: RECURSO,
  })
  comprobar(
    'verificador PKCE equivocado: invalid_grant',
    malVerificador.status === 400 && (await malVerificador.json()).error === 'invalid_grant',
  )

  const { codigo: codigo2, verificador: verificador2 } = await autorizar()
  const otraRedireccion = await formulario({
    grant_type: 'authorization_code',
    code: codigo2,
    client_id: CLIENTE.client_id,
    redirect_uri: 'https://claude.com/api/mcp/auth_callback',
    code_verifier: verificador2,
  })
  comprobar(
    'otra redireccion en el canje: invalid_grant',
    otraRedireccion.status === 400 && (await otraRedireccion.json()).error === 'invalid_grant',
  )

  const recursoAjeno = await formulario({
    grant_type: 'authorization_code',
    code: codigo,
    client_id: CLIENTE.client_id,
    redirect_uri: RETORNO,
    code_verifier: verificador,
    resource: 'https://otro-servidor.invalido/mcp',
  })
  comprobar(
    'resource de otro servidor: invalid_target',
    recursoAjeno.status === 400 && (await recursoAjeno.json()).error === 'invalid_target',
  )

  const bueno = await formulario({
    grant_type: 'authorization_code',
    code: codigo,
    client_id: CLIENTE.client_id,
    redirect_uri: RETORNO,
    code_verifier: verificador,
    resource: RECURSO,
  })
  const emitido = await bueno.json()
  ACCESO = emitido.access_token
  RENOVACION = emitido.refresh_token
  comprobar('canje correcto: 200 con access y refresh', bueno.status === 200 && !!ACCESO && !!RENOVACION)
  comprobar('token de tipo Bearer y de una hora', emitido.token_type === 'Bearer' && emitido.expires_in === 3600)
  comprobar('alcance de solo lectura', emitido.scope === 'roadmap:leer')
  comprobar('no se guarda el token en claro', !tokens.some((t) => t.access_token_hash === ACCESO))
  comprobar(
    'en la base solo esta su SHA-256',
    tokens.some((t) => t.access_token_hash === sha(ACCESO)),
  )
  comprobar('sin cache', bueno.headers.get('Cache-Control') === 'no-store')
}

console.log('\nUn codigo se usa una vez')
{
  const { codigo, verificador } = await autorizar()
  const primero = await formulario({
    grant_type: 'authorization_code',
    code: codigo,
    client_id: CLIENTE.client_id,
    redirect_uri: RETORNO,
    code_verifier: verificador,
  })
  const suAcceso = (await primero.json()).access_token

  const repetido = await formulario({
    grant_type: 'authorization_code',
    code: codigo,
    client_id: CLIENTE.client_id,
    redirect_uri: RETORNO,
    code_verifier: verificador,
  })
  comprobar('el segundo canje del mismo codigo: invalid_grant', repetido.status === 400)

  const despues = await pedirMcp({ token: suAcceso, ...legado('tools/list', {}) })
  comprobar(
    'y el token que salio del primero queda revocado',
    despues.status === 401,
    String(despues.status),
  )
}

console.log('\nLas dos eras del protocolo')
{
  const inicio = await pedirMcp({ token: ACCESO, ...legado('initialize', { protocolVersion: '2025-06-18' }) })
  const resultado = (await inicio.json()).result
  comprobar('initialize (era legada) responde 200', inicio.status === 200)
  comprobar('negocia la version que pide el cliente', resultado.protocolVersion === '2025-06-18')
  comprobar('declara herramientas y nada mas', JSON.stringify(resultado.capabilities) === '{"tools":{}}')
  comprobar('se identifica', resultado.serverInfo.name === 'arboria-roadmap')
  comprobar('no asigna sesion', inicio.headers.get('Mcp-Session-Id') === null)
  comprobar('resultType no aparece en la era legada', resultado.resultType === undefined)

  const aviso = await pedirMcp({
    token: ACCESO,
    ...legado('notifications/initialized', {}),
  })
  comprobar('una notificacion se acepta sin cuerpo: 202', aviso.status === 202)

  const descubrir = await pedirMcp({ token: ACCESO, ...moderno('server/discover', {}) })
  const descubierto = (await descubrir.json()).result
  comprobar('server/discover (era moderna) responde 200', descubrir.status === 200)
  comprobar(
    'anuncia la version moderna',
    JSON.stringify(descubierto.supportedVersions) === JSON.stringify(['2026-07-28']),
  )
  comprobar('y marca el resultado como completo', descubierto.resultType === 'complete')

  const sinCabecera = await pedirMcp({
    token: ACCESO,
    cabeceras: { 'MCP-Protocol-Version': '2026-07-28', 'Content-Type': 'application/json' },
    cuerpo: {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    },
  })
  comprobar(
    'falta Mcp-Method: 400 con -32020',
    sinCabecera.status === 400 && (await sinCabecera.json()).error.code === -32020,
  )

  const versionRara = await pedirMcp({
    token: ACCESO,
    cabeceras: { 'MCP-Protocol-Version': '1999-01-01', 'Content-Type': 'application/json' },
    cuerpo: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
  })
  const errorDeVersion = (await versionRara.json()).error
  comprobar(
    'version desconocida: 400 con -32022 y la lista de las que si',
    versionRara.status === 400 &&
      errorDeVersion.code === -32022 &&
      errorDeVersion.data.supported.includes('2026-07-28') &&
      errorDeVersion.data.supported.includes('2025-06-18'),
  )
}

console.log('\nLas herramientas')
{
  comprobar('hay exactamente dos', HERRAMIENTAS.length === 2, String(HERRAMIENTAS.length))
  comprobar(
    'y las dos leen',
    HERRAMIENTAS.every((h) => h.name.startsWith('leer_')),
    HERRAMIENTAS.map((h) => h.name).join(', '),
  )

  const listado = await pedirMcp({ token: ACCESO, ...legado('tools/list', {}) })
  const nombres = (await listado.json()).result.tools.map((h) => h.name)
  comprobar('tools/list devuelve esas dos', JSON.stringify(nombres) === '["leer_roadmap","leer_nodo"]')

  const inventada = await pedirMcp({
    token: ACCESO,
    ...legado('tools/call', { name: 'escribir_roadmap', arguments: {} }),
  })
  comprobar('llamar a una herramienta que no existe falla', (await inventada.json()).error.code === -32602)

  for (const metodo of ['resources/write', 'tools/update', 'roadmap/escribir']) {
    const respuesta = await pedirMcp({ token: ACCESO, ...legado(metodo, {}) })
    comprobar(`el metodo ${metodo} no existe`, (await respuesta.json()).error.code === -32601)
  }

  const roadmap = await pedirMcp({
    token: ACCESO,
    ...legado('tools/call', { name: 'leer_roadmap', arguments: {} }),
  })
  const texto = (await roadmap.json()).result.content[0].text
  comprobar(
    'leer_roadmap devuelve exactamente lo que produce la exportacion',
    texto === stringifyRoadmapJson(normalizeRoadmapDocument(SONGPLAY)),
  )
  comprobar('con acentos sin escapar', texto.includes('cañón'))
  comprobar('y con el orden de claves de la exportacion',
    Object.keys(JSON.parse(texto)).join(',') === 'schemaVersion,project,ideas,nodes')
  comprobar(
    'ni un dato de mas: nada de la fila de la base',
    !/"owner_id"|"slug"|"updated_at"|"created_at"/.test(texto),
  )

  const nodo = await pedirMcp({
    token: ACCESO,
    ...legado('tools/call', { name: 'leer_nodo', arguments: { id: 'SP.2' } }),
  })
  const fragmento = JSON.parse((await nodo.json()).result.content[0].text)
  comprobar('leer_nodo devuelve el nodo pedido', fragmento.id === 'SP.2' && fragmento.title === 'La Forja')

  const conHijos = await pedirMcp({
    token: ACCESO,
    ...legado('tools/call', { name: 'leer_nodo', arguments: { id: 'SP' } }),
  })
  const raiz = JSON.parse((await conHijos.json()).result.content[0].text)
  comprobar('con sus hijos', raiz.children.length === 3)
  comprobar(
    'y salido del mismo documento normalizado',
    JSON.stringify(raiz) ===
      JSON.stringify(normalizeRoadmapDocument(SONGPLAY).nodes[0]),
  )

  const perdido = await pedirMcp({
    token: ACCESO,
    ...legado('tools/call', { name: 'leer_nodo', arguments: { id: 'NO_EXISTE' } }),
  })
  const aviso = (await perdido.json()).result
  comprobar('un id que no esta se contesta como error de herramienta', aviso.isError === true)
  comprobar('diciendo cuales hay', aviso.content[0].text.includes('SP.2'))
}

console.log('\nUn token abre un proyecto y ninguno mas')
{
  const { codigo, verificador } = await autorizar({ proyecto: PROYECTO_OTRO })
  const emitido = await (
    await formulario({
      grant_type: 'authorization_code',
      code: codigo,
      client_id: CLIENTE.client_id,
      redirect_uri: RETORNO,
      code_verifier: verificador,
    })
  ).json()

  const respuesta = await pedirMcp({
    token: emitido.access_token,
    ...legado('tools/call', { name: 'leer_roadmap', arguments: {} }),
  })
  const leido = JSON.parse((await respuesta.json()).result.content[0].text)
  comprobar('el token del otro proyecto lee el otro proyecto', leido.project.id === 'otro-proyecto')

  const busca = await pedirMcp({
    token: emitido.access_token,
    ...legado('tools/call', { name: 'leer_nodo', arguments: { id: 'SP.2' } }),
  })
  const resultado = (await busca.json()).result
  comprobar('y no ve un nodo del de Songplay', resultado.isError === true)
  comprobar(
    'sin decir que ese nodo existe en otra parte',
    !resultado.content[0].text.includes('Songplay') && !resultado.content[0].text.includes('La Forja'),
    resultado.content[0].text,
  )
}

console.log('\nRechazo, todo con la misma cara')
{
  const respuestas = []
  for (const token of ['', 'inventado', base64url(randomBytes(32))]) {
    const respuesta = await pedirMcp({ token, ...legado('tools/list', {}) })
    respuestas.push(`${respuesta.status} ${respuesta.headers.get('WWW-Authenticate')}`)
  }
  comprobar('sin token, con uno inventado o con basura: siempre 401', respuestas.every((r) => r.startsWith('401')))
  comprobar('y nada en la respuesta dice si algun proyecto existe', new Set(respuestas.slice(1)).size === 1)
}

console.log('\nCaducidad y renovacion')
{
  avanzar(3601)
  const caducado = await pedirMcp({ token: ACCESO, ...legado('tools/list', {}) })
  comprobar('a la hora el token deja de valer: 401', caducado.status === 401, String(caducado.status))

  const renovado = await formulario({
    grant_type: 'refresh_token',
    refresh_token: RENOVACION,
    client_id: CLIENTE.client_id,
    resource: RECURSO,
  })
  const nuevo = await renovado.json()
  comprobar('el refresh token consigue uno nuevo', renovado.status === 200 && !!nuevo.access_token)
  comprobar('y el refresh token rota', nuevo.refresh_token !== RENOVACION)

  const funciona = await pedirMcp({ token: nuevo.access_token, ...legado('tools/list', {}) })
  comprobar('el token nuevo entra', funciona.status === 200)

  const reutilizado = await formulario({
    grant_type: 'refresh_token',
    refresh_token: RENOVACION,
    client_id: CLIENTE.client_id,
  })
  comprobar('reutilizar el refresh viejo: invalid_grant', reutilizado.status === 400)

  const despues = await pedirMcp({ token: nuevo.access_token, ...legado('tools/list', {}) })
  comprobar(
    'y eso revoca la cadena entera, incluido el token nuevo',
    despues.status === 401,
    String(despues.status),
  )

  const ajeno = await formulario({
    grant_type: 'refresh_token',
    refresh_token: RENOVACION,
    client_id: randomUUID(),
  })
  comprobar('un refresh token con otro client_id: invalid_grant', ajeno.status === 400)
}

console.log('\nNada escribe')
{
  rpcLlamadas = []
  const { codigo, verificador } = await autorizar()
  const emitido = await (
    await formulario({
      grant_type: 'authorization_code',
      code: codigo,
      client_id: CLIENTE.client_id,
      redirect_uri: RETORNO,
      code_verifier: verificador,
    })
  ).json()
  const token = emitido.access_token

  rpcLlamadas = []
  for (const peticion of [
    legado('initialize', {}),
    legado('tools/list', {}),
    legado('tools/call', { name: 'leer_roadmap', arguments: {} }),
    legado('tools/call', { name: 'leer_nodo', arguments: { id: 'SP' } }),
    moderno('server/discover', {}),
    moderno('tools/call', { name: 'leer_roadmap', arguments: {} }),
  ]) {
    await pedirMcp({ token, ...peticion })
  }

  comprobar(
    'todo /mcp pasa por una sola funcion de la base, y es de lectura',
    new Set(rpcLlamadas).size === 1 && rpcLlamadas[0] === 'mcp_document_by_access_token',
    [...new Set(rpcLlamadas)].join(', '),
  )
  comprobar(
    'el documento guardado no ha cambiado',
    JSON.stringify(proyectos.get(PROYECTO_SONGPLAY).documento) === JSON.stringify(SONGPLAY),
  )
}

console.log('\nLa API con clave Bearer sigue igual')
{
  const clave = base64url(randomBytes(32))
  clavesDeLectura.set(sha(clave), PROYECTO_SONGPLAY)

  const porClave = await endpointRoadmap(
    new Request(`${ORIGEN}/api/roadmap`, { headers: { Authorization: `Bearer ${clave}` } }),
  )
  const bytesDeLaApi = await porClave.text()
  comprobar('/api/roadmap sigue contestando 200', porClave.status === 200)

  const { codigo, verificador } = await autorizar()
  const emitido = await (
    await formulario({
      grant_type: 'authorization_code',
      code: codigo,
      client_id: CLIENTE.client_id,
      redirect_uri: RETORNO,
      code_verifier: verificador,
    })
  ).json()
  const porMcp = await pedirMcp({
    token: emitido.access_token,
    ...legado('tools/call', { name: 'leer_roadmap', arguments: {} }),
  })
  const bytesDelConector = (await porMcp.json()).result.content[0].text

  console.log(`       /api/roadmap  ${sha(bytesDeLaApi)}  ${Buffer.byteLength(bytesDeLaApi)} bytes`)
  console.log(`       leer_roadmap  ${sha(bytesDelConector)}  ${Buffer.byteLength(bytesDelConector)} bytes`)
  comprobar('las dos vias devuelven exactamente los mismos bytes', bytesDeLaApi === bytesDelConector)

  const sinClave = await endpointRoadmap(new Request(`${ORIGEN}/api/roadmap`))
  comprobar('y sigue rechazando igual sin clave', sinClave.status === 401)

  const conTokenMcp = await endpointRoadmap(
    new Request(`${ORIGEN}/api/roadmap`, {
      headers: { Authorization: `Bearer ${emitido.access_token}` },
    }),
  )
  comprobar('un token del conector no abre /api/roadmap', conTokenMcp.status === 401)

  const conClaveEnMcp = await pedirMcp({ token: clave, ...legado('tools/list', {}) })
  comprobar('y una clave de lectura no abre el conector', conClaveEnMcp.status === 401)
}

// --- Identidad byte a byte con ficheros exportados ---------------------------

const ficheros = process.argv.slice(2)
console.log('\nIdentidad byte a byte')
if (ficheros.length === 0) {
  console.log('  --   sin ficheros que comparar; pasa uno exportado por Arboria como argumento')
} else {
  for (const ruta of ficheros) {
    const bytes = readFileSync(ruta, 'utf8')
    const id = randomUUID()
    proyectos.set(id, { documento: JSON.parse(bytes), owner_id: RUBEN })

    const { codigo, verificador } = await autorizar({ proyecto: id })
    const emitido = await (
      await formulario({
        grant_type: 'authorization_code',
        code: codigo,
        client_id: CLIENTE.client_id,
        redirect_uri: RETORNO,
        code_verifier: verificador,
      })
    ).json()

    const respuesta = await pedirMcp({
      token: emitido.access_token,
      ...legado('tools/call', { name: 'leer_roadmap', arguments: {} }),
    })
    const texto = (await respuesta.json()).result.content[0].text

    console.log(`       ${ruta}`)
    console.log(`       fichero   ${sha(bytes)}  ${Buffer.byteLength(bytes)} bytes`)
    console.log(`       respuesta ${sha(texto)}  ${Buffer.byteLength(texto)} bytes`)
    comprobar('leer_roadmap es byte a byte el fichero', texto === bytes)
  }
}

console.log(fallos === 0 ? '\nTODO CORRECTO\n' : `\n${fallos} FALLOS\n`)
process.exit(fallos === 0 ? 0 : 1)
