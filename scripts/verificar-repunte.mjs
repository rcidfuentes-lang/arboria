#!/usr/bin/env node
/**
 * Comprueba el orden en que se escriben el roadmap y las decisiones cuando se
 * renombra una fase.
 *
 *   node scripts/verificar-repunte.mjs
 *
 * Renombrar toca dos sitios que se guardan distinto: el arbol viaja con el
 * autoguardado —900 ms despues, con guarda de updated_at— y las decisiones son
 * una escritura inmediata a su tabla. El estado que hay que evitar es
 * "decisiones movidas y arbol no": deja en el servidor decisiones apuntando a
 * un id que alli no existe. Por eso el arbol va primero y las decisiones
 * despues, y esto ejercita esa decision en las siete situaciones posibles.
 *
 * Esto no toca ni la base ni la red: queHacerConElRepunte es una funcion pura.
 * Lo que no comprueba es que el efecto de React la llame bien ni que el UPDATE
 * de Supabase haga lo suyo; eso se prueba en el navegador, forzando el fallo
 * del guardado, y esta anotado en el informe de la auditoria.
 */
import { pathToFileURL } from 'node:url'

const { esMomentoDeRepuntar, queHacerSegunElDocumento, colaDespuesDeIntentar } = await import(
  pathToFileURL(new URL('../src/lib/orden-del-repunte.ts', import.meta.url).pathname).href
)

let fallos = 0
function comprobar(etiqueta, real, esperado) {
  const bien = real === esperado
  if (!bien) fallos += 1
  console.log(`${bien ? '  ok  ' : ' MAL  '} ${etiqueta}  ->  ${real}${bien ? '' : ` (se esperaba ${esperado})`}`)
}

console.log('Cuando es momento de mirar la cola: solo con el arbol ya arriba')
comprobar('guardado local: hay cosas sin subir', esMomentoDeRepuntar('local'), false)
comprobar('guardado syncing: esta en vuelo', esMomentoDeRepuntar('syncing'), false)
comprobar('guardado synced: lo de la pantalla es lo de arriba', esMomentoDeRepuntar('synced'), true)
comprobar('guardado error: se rindio o hubo conflicto', esMomentoDeRepuntar('error'), false)

console.log('\nQue hacer segun el documento que quedo guardado')
const REPUNTE = { idViejo: 'SP4.1.3', idNuevo: 'SP4.1.9' }
comprobar(
  'el renombrado subio: esta el nuevo y no el viejo',
  queHacerSegunElDocumento(REPUNTE, ['SP', 'SP4', 'SP4.1', 'SP4.1.9']),
  'repuntar',
)
comprobar(
  'el renombrado no esta en el documento: se deshizo o gano la copia del servidor',
  queHacerSegunElDocumento(REPUNTE, ['SP', 'SP4', 'SP4.1', 'SP4.1.3']),
  'descartar',
)
comprobar(
  'estan los dos: alguien reuso el id viejo, las decisiones citan una fase que existe',
  queHacerSegunElDocumento(REPUNTE, ['SP4.1.3', 'SP4.1.9']),
  'descartar',
)
comprobar(
  'no esta ninguno de los dos: la rama entera se fue',
  queHacerSegunElDocumento(REPUNTE, ['SP', 'SP4']),
  'descartar',
)

console.log('\nHueco 1: cerrar el proyecto antes de que termine el guardado')
console.log('  El arbol renombrado se queda en la cache y sube al reabrir. La cola')
console.log('  vive en localStorage al lado de esa cache, asi que al abrir con el')
console.log('  documento ya al dia el repunte sigue ahi y se ejecuta.')
comprobar(
  'al abrir al dia con el renombrado ya arriba, se repunta',
  esMomentoDeRepuntar('synced') &&
    queHacerSegunElDocumento(REPUNTE, ['SP4.1.9']) === 'repuntar'
    ? 'se repunta'
    : 'no se repunta',
  'se repunta',
)
comprobar(
  'al abrir con el guardado todavia pendiente, no se toca nada',
  esMomentoDeRepuntar('local') ? 'se toca' : 'no se toca',
  'no se toca',
)

console.log('\nHueco 2: el arbol sube y falla el UPDATE de las decisiones')
const TRES = [
  { idViejo: 'A', idNuevo: 'A2' },
  { idViejo: 'B', idNuevo: 'B2' },
  { idViejo: 'C', idNuevo: 'C2' },
]
const cola = colaDespuesDeIntentar(TRES, (r) =>
  r.idViejo === 'B' ? 'fallo' : r.idViejo === 'C' ? 'descartado' : 'hecho',
)
comprobar('el que fallo se queda para reintentarlo', cola.map((r) => r.idViejo).join(','), 'B')
comprobar('el que salio bien se va', cola.some((r) => r.idViejo === 'A') ? 'sigue' : 'se fue', 'se fue')
comprobar('el descartado se va', cola.some((r) => r.idViejo === 'C') ? 'sigue' : 'se fue', 'se fue')
comprobar(
  'si fallan todos, no se pierde ninguno',
  colaDespuesDeIntentar(TRES, () => 'fallo').length,
  3,
)
comprobar(
  'si salen todos bien, la cola queda vacia',
  colaDespuesDeIntentar(TRES, () => 'hecho').length,
  0,
)

console.log('\nLo que nunca puede pasar')
comprobar(
  'ningun estado distinto de synced deja mirar la cola',
  ['local', 'syncing', 'error'].some((estado) => esMomentoDeRepuntar(estado))
    ? 'alguno deja'
    : 'ninguno deja',
  'ninguno deja',
)
comprobar(
  'sin el id nuevo en el documento no se mueve una decision jamas',
  [['SP4.1.3'], [], ['SP4.1.3', 'otra']].some(
    (ids) => queHacerSegunElDocumento(REPUNTE, ids) === 'repuntar',
  )
    ? 'alguno mueve'
    : 'ninguno mueve',
  'ninguno mueve',
)

console.log(`\n${fallos === 0 ? 'Todo en orden.' : `${fallos} comprobacion(es) mal.`}`)
process.exit(fallos === 0 ? 0 : 1)
