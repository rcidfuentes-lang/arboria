#!/usr/bin/env node
/**
 * Comprueba la lectura del fichero de decisiones: lo que la pantalla acepta,
 * lo que rechaza y que mensaje da.
 *
 *   node scripts/verificar-import-decisiones.mjs
 *
 * Esto no toca ni la base ni la red: leerFicheroDeDecisiones es una funcion
 * pura, y lo que se ejercita aqui es justo lo que decide si Ruben ve un error
 * entendible o un fallo de Postgres. Que un fichero malo no deje nada escrito
 * lo comprueba el SQL, en scripts/sql/03-pruebas-importar.sql, porque eso es
 * cosa de la transaccion y no de esta funcion.
 */
import { pathToFileURL } from 'node:url'

const { leerFicheroDeDecisiones, ejemploDeFichero } = await import(
  pathToFileURL(new URL('../src/lib/decisiones-import.ts', import.meta.url).pathname).href
)

let fallos = 0
function comprobar(etiqueta, condicion, detalle = '') {
  if (!condicion) fallos += 1
  console.log(`${condicion ? '  ok  ' : ' MAL  '} ${etiqueta}${detalle ? `  ->  ${detalle}` : ''}`)
}

const YA_ESCRITAS = [
  { numero: 1, decidido: 'Una que ya estaba escrita.', fecha: '2026-09-10' },
  { numero: 2, decidido: 'Y otra.', fecha: '2026-09-11' },
]

const leer = (valor, existentes = YA_ESCRITAS) =>
  leerFicheroDeDecisiones(typeof valor === 'string' ? valor : JSON.stringify(valor), existentes)

const UNA_BUENA = {
  decidido: 'El decisor va en tabla propia.',
  fecha: '2026-09-20',
  motivo: 'Los bytes de /api/roadmap no se tocan.',
  tema: 'arquitectura',
}

console.log('\nLo que entra')
{
  const lista = leer([UNA_BUENA])
  comprobar('una lista pelada vale', lista.ok && lista.plan.nuevas === 1)

  const conClave = leer({ decisiones: [UNA_BUENA] })
  comprobar('y un objeto con "decisiones" dentro tambien', conClave.ok)

  const conVersion = leer({ schemaVersion: 1, decisiones: [UNA_BUENA] })
  comprobar('schemaVersion arriba no estorba', conVersion.ok)

  const completa = leer([
    { ...UNA_BUENA, ref: 'tabla-propia', detalle: 'el acta', nodo: 'SP1.3' },
  ])
  comprobar(
    'los campos opcionales entran',
    completa.ok &&
      completa.plan.entradas[0].detalle === 'el acta' &&
      completa.plan.entradas[0].nodo === 'SP1.3',
  )

  const sinOpcionales = leer([UNA_BUENA])
  comprobar(
    'y los que no vienen quedan nulos, no vacios',
    sinOpcionales.ok &&
      sinOpcionales.plan.entradas[0].detalle === null &&
      sinOpcionales.plan.entradas[0].nodo === null,
  )

  const elEjemplo = leer(ejemploDeFichero, [])
  comprobar(
    'el ejemplo que ensena la pantalla se importa tal cual',
    elEjemplo.ok && elEjemplo.plan.nuevas === 2 && elEjemplo.plan.inactivaciones === 1,
    elEjemplo.ok ? '' : elEjemplo.errores.join(' | '),
  )
}

console.log('\nLa sustitucion')
{
  const porRef = leer([
    { ...UNA_BUENA, ref: 'nueva' },
    {
      decidido: 'La vieja.',
      fecha: '2026-09-14',
      motivo: 'Era lo barato.',
      tema: 'arquitectura',
      inactiva: { motivo: 'La nueva lo dice mejor.', sustituida_por: 'nueva' },
    },
  ])
  comprobar('una entrada puede senalar a otra del mismo fichero', porRef.ok)
  comprobar('y se cuenta como inactivacion', porRef.ok && porRef.plan.inactivaciones === 1)

  const haciaAtras = leer([
    {
      decidido: 'La vieja.',
      fecha: '2026-09-14',
      motivo: 'Era lo barato.',
      tema: 'arquitectura',
      inactiva: { motivo: 'x', sustituida_por: 'nueva' },
    },
    { ...UNA_BUENA, ref: 'nueva' },
  ])
  comprobar('puede senalar a una que viene despues en el fichero', haciaAtras.ok)

  const porNumero = leer([
    {
      decidido: 'La vieja.',
      fecha: '2026-09-14',
      motivo: 'Era lo barato.',
      tema: 'arquitectura',
      inactiva: { motivo: 'x', sustituida_por: 2 },
    },
  ])
  comprobar('y a una ya escrita, por su numero', porNumero.ok)

  const numeroQueNoEsta = leer([
    { ...UNA_BUENA, inactiva: { motivo: 'x', sustituida_por: 99 } },
  ])
  comprobar(
    'un numero que no existe se rechaza y se dice',
    !numeroQueNoEsta.ok && numeroQueNoEsta.errores[0].includes('99'),
    numeroQueNoEsta.ok ? '' : numeroQueNoEsta.errores[0],
  )

  const refQueNoEsta = leer([
    { ...UNA_BUENA, inactiva: { motivo: 'x', sustituida_por: 'fantasma' } },
  ])
  comprobar(
    'un ref que no existe se rechaza y se dice cual',
    !refQueNoEsta.ok && refQueNoEsta.errores[0].includes('fantasma'),
    refQueNoEsta.ok ? '' : refQueNoEsta.errores[0],
  )

  const aSiMisma = leer([{ ...UNA_BUENA, ref: 'yo', inactiva: { motivo: 'x', sustituida_por: 'yo' } }])
  comprobar('una decision no se sustituye a si misma', !aSiMisma.ok)

  const sinSustituta = leer([{ ...UNA_BUENA, inactiva: { motivo: 'ya no vale' } }])
  comprobar('inactiva sin sustituta se rechaza', !sinSustituta.ok)

  const sinMotivo = leer([{ ...UNA_BUENA, inactiva: { sustituida_por: 2 } }])
  comprobar('inactiva sin motivo se rechaza', !sinMotivo.ok)

  const refRepetido = leer([
    { ...UNA_BUENA, ref: 'repe' },
    { ...UNA_BUENA, decidido: 'Otra cosa.', ref: 'repe' },
  ])
  comprobar('dos entradas con el mismo ref se rechazan', !refRepetido.ok)
}

console.log('\nLo que se rechaza')
{
  comprobar('un JSON roto', !leer('{ esto no es json').ok)
  comprobar('una lista vacia', !leer([]).ok)
  comprobar('un numero suelto', !leer('42').ok)
  comprobar('una entrada que no es un objeto', !leer(['una cadena']).ok)

  for (const campo of ['decidido', 'fecha', 'motivo', 'tema']) {
    const sinEl = { ...UNA_BUENA }
    delete sinEl[campo]
    const salida = leer([sinEl])
    comprobar(
      `falta "${campo}"`,
      !salida.ok && salida.errores.some((mensaje) => mensaje.includes(campo)),
      salida.ok ? '' : salida.errores[0],
    )
  }

  const enBlanco = leer([{ ...UNA_BUENA, decidido: '    ' }])
  comprobar('un campo obligatorio con solo espacios no cuela', !enBlanco.ok)

  const erratas = leer([
    { decidido: 'x', fecha: '2026-09-20', 'por que': 'la errata', tema: 'x', motivo: 'y' },
  ])
  comprobar(
    'un campo que no existe se dice en vez de tragarselo',
    !erratas.ok && erratas.errores[0].includes('por que'),
    erratas.ok ? '' : erratas.errores[0],
  )

  for (const fecha of ['2026-02-31', '2026-13-01', '20/09/2026', '2026-9-1', 'ayer', '']) {
    const salida = leer([{ ...UNA_BUENA, fecha }])
    comprobar(`la fecha "${fecha}" se rechaza`, !salida.ok)
  }

  comprobar('el 29 de febrero de un bisiesto si vale', leer([{ ...UNA_BUENA, fecha: '2028-02-29' }]).ok)
  comprobar('y el de uno que no lo es, no', !leer([{ ...UNA_BUENA, fecha: '2026-02-29' }]).ok)

  const variosFallos = leer([
    { decidido: '', fecha: 'mal', motivo: '', tema: '' },
    { decidido: 'x', fecha: '2026-01-01', motivo: 'y', tema: 'z', inventado: 1 },
  ])
  comprobar(
    'salen todos los fallos juntos, no el primero',
    !variosFallos.ok && variosFallos.errores.length >= 5,
    `${variosFallos.errores.length} errores`,
  )
}

console.log('\nLo que ya estaba escrito')
{
  const repetida = leer([
    { decidido: 'Una que ya estaba escrita.', fecha: '2026-09-10', motivo: 'x', tema: 'y' },
    UNA_BUENA,
  ])
  comprobar('una que ya estaba no se cuenta como nueva', repetida.ok && repetida.plan.nuevas === 1)
  comprobar(
    'y se dice con que numero esta',
    repetida.ok && repetida.plan.yaEstaban.length === 1 && repetida.plan.yaEstaban[0].numero === 1,
  )

  const mismoTextoOtroDia = leer([
    { decidido: 'Una que ya estaba escrita.', fecha: '2026-09-19', motivo: 'x', tema: 'y' },
  ])
  comprobar(
    'el mismo texto en otra fecha si es nueva',
    mismoTextoOtroDia.ok && mismoTextoOtroDia.plan.nuevas === 1,
  )
}

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`}`)
process.exit(fallos === 0 ? 0 : 1)
