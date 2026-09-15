#!/usr/bin/env node
/**
 * Comprueba la API de lectura sin desplegar y sin tocar Supabase.
 *
 *   node scripts/verificar-api-roadmap.mjs [fichero-exportado.json ...]
 *
 * Simula la funcion roadmap_document_by_key —incluyendo que Postgres reordena
 * las claves de todo objeto jsonb por longitud y luego por bytes— y llama al
 * endpoint real. Las claves son de usar y tirar: se generan aqui, no salen del
 * proceso y no llegan a ninguna base.
 *
 * Con un fichero por argumento comprueba lo que de verdad importa: que la
 * respuesta es byte a byte ese fichero. Es la comprobacion que impide que el
 * JSON del repositorio de Songplay cambie sin que cambie el roadmap.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  normalizeRoadmapDocument,
  stringifyRoadmapJson,
} from '../src/lib/roadmap-document.ts'

const sha = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex')

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

const FIXTURE = {
  schemaVersion: 1,
  project: { id: 'proyecto-de-prueba', name: 'Proyecto de prueba' },
  ideas: [],
  nodes: [
    {
      id: 'P1',
      title: 'Una fase con hijos',
      status: 'planned',
      content: 'Contenido con acentos: cañón, ó, —.',
      children: [
        { id: 'P1.1', title: 'Cerrada', status: 'closed', content: '', children: [] },
        { id: 'P1.2', title: 'En curso', status: 'in_progress', content: '', children: [] },
      ],
    },
  ],
}

const OTRO_PROYECTO = {
  schemaVersion: 1,
  project: { id: 'otro-proyecto', name: 'Otro proyecto' },
  ideas: [],
  nodes: [{ id: 'OP1', title: 'Fase del otro', status: 'planned', content: '', children: [] }],
}

const CON_IDEAS = {
  schemaVersion: 1,
  project: { id: 'con-ideas', name: 'Con ideas' },
  ideas: [
    {
      id: 'i1',
      title: 'Una idea',
      bodyHtml: '<p>algo <b>en negrita</b></p>',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  nodes: [],
}

// --- Base simulada ----------------------------------------------------------

const claves = new Map()
function alta(documento, { revocada = false } = {}) {
  const clave = randomBytes(32).toString('base64url')
  claves.set(sha(clave), { documento, revocada })
  return clave
}

const ficheros = process.argv.slice(2).map((ruta) => {
  const bytes = readFileSync(ruta, 'utf8')
  return { ruta, bytes, documento: JSON.parse(bytes), clave: null }
})

const claveFixture = alta(FIXTURE)
const claveOtro = alta(OTRO_PROYECTO)
const claveRevocada = alta(FIXTURE, { revocada: true })
const claveConIdeas = alta(CON_IDEAS)
const claveCorrupto = alta({ cualquier: 'cosa' })
for (const fichero of ficheros) fichero.clave = alta(fichero.documento)

let llamadas = 0
globalThis.fetch = async (url, init) => {
  llamadas += 1
  if (!String(url).endsWith('/rest/v1/rpc/roadmap_document_by_key')) {
    throw new Error(`ruta inesperada: ${url}`)
  }
  const fila = claves.get(sha(JSON.parse(init.body).api_key))
  const resultado = !fila || fila.revocada ? null : comoJsonb(fila.documento)
  return new Response(JSON.stringify(resultado), { status: 200 })
}

process.env.SUPABASE_URL = 'https://ejemplo.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'clave-anonima-de-prueba'

const { default: handler } = await import(
  pathToFileURL(new URL('../netlify/functions/roadmap.mts', import.meta.url).pathname).href
)

const pedir = (opciones = {}) =>
  handler(
    new Request('https://ejemplo.netlify.app/api/roadmap', {
      method: opciones.metodo ?? 'GET',
      headers: opciones.clave === undefined ? {} : { Authorization: `Bearer ${opciones.clave}` },
    }),
  )

// --- Comprobaciones ---------------------------------------------------------

let fallos = 0
function comprobar(etiqueta, condicion, detalle = '') {
  if (!condicion) fallos += 1
  console.log(`${condicion ? '  ok  ' : ' MAL  '} ${etiqueta}${detalle ? `  ->  ${detalle}` : ''}`)
}

console.log('\nRechazo')
for (const [etiqueta, opciones] of [
  ['sin cabecera Authorization', {}],
  ['cabecera Bearer vacia', { clave: '' }],
  ['clave inventada', { clave: randomBytes(32).toString('base64url') }],
  ['clave revocada', { clave: claveRevocada }],
]) {
  const respuesta = await pedir(opciones)
  const cuerpo = await respuesta.text()
  comprobar(
    `${etiqueta}: 401 identico, sin decir si el proyecto existe`,
    respuesta.status === 401 && cuerpo === '{"error":"unauthorized"}\n',
    `${respuesta.status} ${cuerpo.trim()}`,
  )
}
for (const metodo of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const respuesta = await pedir({ metodo, clave: claveFixture })
  comprobar(`${metodo} con clave buena: 405`, respuesta.status === 405, String(respuesta.status))
}
{
  const cuerpo = await (await pedir({ clave: claveOtro })).text()
  comprobar(
    'una clave solo abre su proyecto',
    JSON.parse(cuerpo).project.id === 'otro-proyecto',
    JSON.parse(cuerpo).project.id,
  )
}

console.log('\nFallo en alto en vez de divergir')
{
  const respuesta = await pedir({ clave: claveConIdeas })
  const cuerpo = await respuesta.text()
  comprobar(
    'ideas con contenido: 409 ideas_require_dom, no unos bytes distintos',
    respuesta.status === 409 && cuerpo.includes('ideas_require_dom'),
    `${respuesta.status} ${cuerpo.trim()}`,
  )
}
{
  const respuesta = await pedir({ clave: claveCorrupto })
  comprobar(
    'documento que no es un roadmap: 409, no un roadmap vacio plausible',
    respuesta.status === 409,
    String(respuesta.status),
  )
}

console.log('\nForma de la respuesta')
{
  const respuesta = await pedir({ clave: claveFixture })
  const cuerpo = await respuesta.text()
  comprobar(
    'es exactamente lo que produce la exportacion',
    cuerpo === stringifyRoadmapJson(normalizeRoadmapDocument(FIXTURE)),
  )
  comprobar(
    'llega con el orden de claves de jsonb',
    Object.keys(comoJsonb(FIXTURE)).join(',') === 'ideas,nodes,project,schemaVersion',
  )
  comprobar(
    'y sale con el orden de la exportacion',
    Object.keys(JSON.parse(cuerpo)).join(',') === 'schemaVersion,project,ideas,nodes',
  )
  comprobar('indentacion de 2', cuerpo.split('\n')[1] === '  "schemaVersion": 1,')
  comprobar('salto de linea final', cuerpo.endsWith('}\n'))
  comprobar('acentos sin escapar', cuerpo.includes('cañón'))
  comprobar('Cache-Control: no-store', respuesta.headers.get('Cache-Control') === 'no-store')
  comprobar(
    'ni un dato de mas: nada de la fila ni envoltura',
    !/"owner_id"|"slug"|"updated_at"|"created_at"|"source"|"document"/.test(cuerpo),
  )
}

if (ficheros.length === 0) {
  console.log('\nIdentidad byte a byte')
  console.log('  --   sin ficheros que comparar; pasa uno exportado por Arboria como argumento')
} else {
  console.log('\nIdentidad byte a byte')
  for (const fichero of ficheros) {
    const cuerpo = await (await pedir({ clave: fichero.clave })).text()
    const igual = cuerpo === fichero.bytes
    console.log(`       ${fichero.ruta}`)
    console.log(`       fichero   ${sha(fichero.bytes)}  ${Buffer.byteLength(fichero.bytes)} bytes`)
    console.log(`       respuesta ${sha(cuerpo)}  ${Buffer.byteLength(cuerpo)} bytes`)
    comprobar('la respuesta es byte a byte el fichero', igual)
  }
}

console.log(`\nllamadas a la base simulada: ${llamadas}`)
console.log(fallos === 0 ? 'TODO CORRECTO\n' : `${fallos} FALLOS\n`)
process.exit(fallos === 0 ? 0 : 1)
