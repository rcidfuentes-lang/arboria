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
  { numero: 1, decidido: 'Una que ya estaba escrita.', fecha: '2026-09-10', estado: 'activa', norma: null },
  { numero: 2, decidido: 'Y otra.', fecha: '2026-09-11', estado: 'activa', norma: null },
  {
    numero: 3,
    decidido: 'Una que ya apunta al canon.',
    fecha: '2026-09-12',
    estado: 'activa',
    norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' },
  },
  {
    numero: 4,
    decidido: 'Una que ya estaba retirada.',
    fecha: '2026-09-13',
    estado: 'inactiva',
    norma: null,
  },
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
    elEjemplo.ok && elEjemplo.plan.nuevas === 4 && elEjemplo.plan.inactivaciones === 2,
    elEjemplo.ok ? '' : elEjemplo.errores.join(' | '),
  )
}

console.log('\nLos ficheros de antes siguen valiendo')
{
  // Esta es la comprobacion que importa de verdad: ninguno de los ficheros que
  // Ruben ya tiene escritos habla de normas, y todos tienen que entrar igual.
  const deAntes = leer({
    schemaVersion: 1,
    decisiones: [
      { ...UNA_BUENA, ref: 'nueva', detalle: 'el acta', nodo: 'SP1.3' },
      {
        decidido: 'La vieja.',
        fecha: '2026-09-14',
        motivo: 'Era lo barato.',
        tema: 'arquitectura',
        inactiva: { motivo: 'La nueva lo dice mejor.', sustituida_por: 'nueva' },
      },
      {
        decidido: 'Otra vieja.',
        fecha: '2026-09-13',
        motivo: 'x',
        tema: 'proceso',
        inactiva: { motivo: 'y', sustituida_por: 2 },
      },
    ],
  })
  comprobar(
    'un fichero sin ninguna norma entra exactamente igual que antes',
    deAntes.ok && deAntes.plan.nuevas === 3 && deAntes.plan.inactivaciones === 2,
    deAntes.ok ? '' : deAntes.errores.join(' | '),
  )
  comprobar(
    'y sus entradas salen con norma nula, no con un hueco raro',
    deAntes.ok && deAntes.plan.entradas.every((entrada) => entrada.norma === null),
  )
  comprobar('y no pone ninguna norma a nada', deAntes.ok && deAntes.plan.normasPuestas === 0)
}

console.log('\nLa norma')
{
  const conNorma = leer([
    { ...UNA_BUENA, norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' } },
  ])
  comprobar(
    'una decision activa puede declarar que norma la recoge',
    conNorma.ok &&
      conNorma.plan.entradas[0].norma.documento === 'docs/SP3-canon.md' &&
      conNorma.plan.entradas[0].norma.apartado === '§7.5' &&
      conNorma.plan.entradas[0].inactiva === null,
    conNorma.ok ? '' : conNorma.errores.join(' | '),
  )

  const sinApartado = leer([{ ...UNA_BUENA, norma: { documento: 'docs/SP3-canon.md' } }])
  comprobar(
    'el apartado es opcional',
    sinApartado.ok && sinApartado.plan.entradas[0].norma.apartado === null,
    sinApartado.ok ? '' : sinApartado.errores.join(' | '),
  )

  const apartadoSuelto = leer([{ ...UNA_BUENA, norma: { apartado: '§7.5' } }])
  comprobar(
    'un apartado sin documento se rechaza y se dice por que',
    !apartadoSuelto.ok && apartadoSuelto.errores[0].includes('documento'),
    apartadoSuelto.ok ? '' : apartadoSuelto.errores[0],
  )

  const normaComoCadena = leer([{ ...UNA_BUENA, norma: 'docs/SP3-canon.md §7.5' }])
  comprobar('la norma como cadena suelta no se adivina, se rechaza', !normaComoCadena.ok)

  const campoRaroDentro = leer([
    { ...UNA_BUENA, norma: { documento: 'docs/SP3-canon.md', seccion: '§7.5' } },
  ])
  comprobar(
    'una errata dentro de "norma" se dice en vez de tragarsela',
    !campoRaroDentro.ok && campoRaroDentro.errores[0].includes('seccion'),
    campoRaroDentro.ok ? '' : campoRaroDentro.errores[0],
  )
}

console.log('\nRetirar apuntando a una norma')
{
  const porNorma = leer([
    {
      ...UNA_BUENA,
      norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' },
      inactiva: { motivo: 'Ya lo dice el canon.' },
    },
  ])
  comprobar(
    'con norma puesta, "inactiva" ya no necesita "sustituida_por"',
    porNorma.ok &&
      porNorma.plan.inactivaciones === 1 &&
      porNorma.plan.entradas[0].inactiva.sustituida_por === null,
    porNorma.ok ? '' : porNorma.errores.join(' | '),
  )

  const niUnaNiOtra = leer([{ ...UNA_BUENA, inactiva: { motivo: 'ya no vale' } }])
  comprobar(
    'sin sustituta y sin norma se rechaza, que es la regla de siempre',
    !niUnaNiOtra.ok && niUnaNiOtra.errores[0].includes('norma'),
    niUnaNiOtra.ok ? '' : niUnaNiOtra.errores[0],
  )

  const normaYSustituta = leer([
    { ...UNA_BUENA, ref: 'nueva' },
    {
      decidido: 'La vieja.',
      fecha: '2026-09-14',
      motivo: 'x',
      tema: 'y',
      norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' },
      inactiva: { motivo: 'z', sustituida_por: 'nueva' },
    },
  ])
  comprobar(
    'una decision puede estar en una norma y ademas ser sustituida por otra',
    normaYSustituta.ok && normaYSustituta.plan.inactivaciones === 1,
    normaYSustituta.ok ? '' : normaYSustituta.errores.join(' | '),
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
  comprobar('inactiva sin sustituta y sin norma se rechaza', !sinSustituta.ok)

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

  // La unica excepcion a "importar no pisa lo que ya hay", y la que hace
  // posible marcar cien decisiones de golpe: exportar, anadir la norma,
  // reimportar.
  const leAnadeLaNorma = leer([
    {
      decidido: 'Una que ya estaba escrita.',
      fecha: '2026-09-10',
      motivo: 'x',
      tema: 'y',
      norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' },
    },
  ])
  comprobar(
    'a una que ya estaba se le pone la norma que trae el fichero',
    leAnadeLaNorma.ok &&
      leAnadeLaNorma.plan.nuevas === 0 &&
      leAnadeLaNorma.plan.normasPuestas === 1 &&
      leAnadeLaNorma.plan.yaEstaban[0].norma === true,
    leAnadeLaNorma.ok ? '' : leAnadeLaNorma.errores.join(' | '),
  )

  const laMismaNorma = leer([
    {
      decidido: 'Una que ya apunta al canon.',
      fecha: '2026-09-12',
      motivo: 'x',
      tema: 'y',
      norma: { documento: 'docs/SP3-canon.md', apartado: '§7.5' },
    },
  ])
  comprobar(
    'si ya tiene esa misma norma, no se toca nada',
    laMismaNorma.ok && laMismaNorma.plan.normasPuestas === 0,
    laMismaNorma.ok ? '' : laMismaNorma.errores.join(' | '),
  )

  const otroApartado = leer([
    {
      decidido: 'Una que ya apunta al canon.',
      fecha: '2026-09-12',
      motivo: 'x',
      tema: 'y',
      norma: { documento: 'docs/SP3-canon.md', apartado: '§8.1' },
    },
  ])
  comprobar(
    'cambiar solo el apartado tambien cuenta',
    otroApartado.ok && otroApartado.plan.normasPuestas === 1,
  )

  const sinDecirNorma = leer([
    { decidido: 'Una que ya apunta al canon.', fecha: '2026-09-12', motivo: 'x', tema: 'y' },
  ])
  comprobar(
    'una entrada sin norma no borra la que la decision ya tenia',
    sinDecirNorma.ok &&
      sinDecirNorma.plan.normasPuestas === 0 &&
      sinDecirNorma.plan.yaEstaban[0].norma === false,
  )
}

console.log('\nRetirar decisiones que ya estan escritas')
{
  // El caso de la poda: un fichero de solo decisiones ya escritas, cada una
  // con su "inactiva". Antes el plan decia "se escribiran 0" y no habia nada
  // que hacer; ahora dice a cuantas se les va a retirar.
  const poda = leer([
    {
      decidido: 'Una que ya estaba escrita.',
      fecha: '2026-09-10',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'Lo dice mejor la 2.', sustituida_por: 2 },
    },
    {
      decidido: 'Y otra.',
      fecha: '2026-09-11',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'Tambien.', sustituida_por: 3 },
    },
  ])
  comprobar('un fichero de solo decisiones ya escritas se lee', poda.ok,
    poda.ok ? '' : poda.errores.join(' | '))
  comprobar('no escribe ninguna nueva', poda.ok && poda.plan.nuevas === 0)
  comprobar('y dice que a dos se les retirara', poda.ok && poda.plan.retiradas === 2)
  comprobar('con sus numeros, para poder mirarlos antes',
    poda.ok &&
      poda.plan.yaEstaban.filter((f) => f.retirar).map((f) => f.numero).join(',') === '1,2')
  comprobar(
    '"inactivaciones" ya no las cuenta: esas son las nuevas que nacen inactivas',
    poda.ok && poda.plan.inactivaciones === 0,
  )

  const naceInactiva = leer([
    { ...UNA_BUENA, ref: 'nueva' },
    {
      decidido: 'Una nueva que nace retirada.',
      fecha: '2026-09-21',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'z', sustituida_por: 'nueva' },
    },
  ])
  comprobar('una nueva que nace inactiva si cuenta ahi',
    naceInactiva.ok && naceInactiva.plan.inactivaciones === 1 && naceInactiva.plan.retiradas === 0)

  const yaRetirada = leer([
    {
      decidido: 'Una que ya estaba retirada.',
      fecha: '2026-09-13',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'Otro motivo distinto.', sustituida_por: 2 },
    },
  ])
  comprobar('una que ya estaba retirada no se cuenta para retirar',
    yaRetirada.ok && yaRetirada.plan.retiradas === 0 && yaRetirada.plan.yaInactivas === 1,
    yaRetirada.ok ? '' : yaRetirada.errores.join(' | '))

  const sinInactiva = leer([
    { decidido: 'Una que ya estaba retirada.', fecha: '2026-09-13', motivo: 'x', tema: 'y' },
  ])
  comprobar('y una entrada sin "inactiva" no la marca para nada',
    sinInactiva.ok &&
      sinInactiva.plan.retiradas === 0 &&
      sinInactiva.plan.yaInactivas === 0 &&
      sinInactiva.plan.yaEstaban[0].retirar === false)

  const aSiMismaPorNumero = leer([
    {
      decidido: 'Una que ya estaba escrita.',
      fecha: '2026-09-10',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'z', sustituida_por: 1 },
    },
  ])
  comprobar(
    'una entrada que se pone a si misma de sustituta se dice antes de escribir',
    !aSiMismaPorNumero.ok && aSiMismaPorNumero.errores[0].includes('si misma'),
    aSiMismaPorNumero.ok ? '' : aSiMismaPorNumero.errores[0],
  )

  const aOtraQueExiste = leer([
    {
      decidido: 'Una que ya estaba escrita.',
      fecha: '2026-09-10',
      motivo: 'x',
      tema: 'y',
      inactiva: { motivo: 'z', sustituida_por: 2 },
    },
  ])
  comprobar('apuntar a otra que existe sigue valiendo', aOtraQueExiste.ok)
}

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`}`)
process.exit(fallos === 0 ? 0 : 1)
