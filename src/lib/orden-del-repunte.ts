/**
 * En que orden se escriben el roadmap y las decisiones al renombrar una fase.
 *
 * Esta aqui, en un fichero suelto y sin un solo import, por la misma razon que
 * guardado.ts: es la parte del renombrado que se puede mirar de frente y que
 * conviene poder ejercitar sin navegador ni base. La ejercita
 * scripts/verificar-repunte.mjs.
 *
 * El caso que obliga a escribirlo: renombrar toca dos sitios que se guardan de
 * maneras distintas. El arbol viaja con el autoguardado —900 ms despues, con
 * guarda de updated_at— y las decisiones son una escritura inmediata a su
 * tabla. Tal y como se escribio primero, las decisiones se movian al aceptar el
 * modal y el arbol subia despues: si ese guardado fallaba o daba conflicto, en
 * el servidor quedaban decisiones apuntando a un id que alli no existia.
 */

/** Un renombrado aceptado cuyas decisiones todavia no se han movido. */
export type RepuntePendiente = {
  idViejo: string
  idNuevo: string
}

/** El estado del autoguardado, tal y como lo ve el editor. */
export type EstadoDeGuardado = 'local' | 'syncing' | 'synced' | 'error'

/**
 * Si es momento de mirar siquiera si hay algo que repuntar.
 *
 * 'synced' es lo unico que quiere decir "lo que hay en pantalla es lo que hay
 * arriba". En 'local' y 'syncing' hay cosas sin subir o en vuelo, y en 'error'
 * el guardado se rindio o hubo conflicto: en los tres casos no se toca nada.
 *
 * Que en 'error' se espere y no se abandone es deliberado y es la correccion de
 * un hueco: el repunte sobrevive en localStorage y se reintenta en el guardado
 * siguiente, sea de esta apertura o de la proxima. Lo que decide si sigue
 * teniendo sentido no es este estado, es el documento —lo mira
 * queHacerSegunElDocumento—, asi que abandonar aqui era tirar trabajo pendiente
 * por un fallo que casi siempre es pasajero.
 */
export function esMomentoDeRepuntar(guardado: EstadoDeGuardado) {
  return guardado === 'synced'
}

/**
 * Que hacer con un repunte, mirando el documento que acaba de quedar guardado.
 *
 * Solo se pregunta en un momento asentado —justo despues de un guardado con
 * exito, o al abrir un proyecto que ya esta al dia—, y entonces el documento es
 * lo que hay en el servidor. Por eso no hay un 'esperar': o el renombrado esta
 * arriba, o ya no esta en el documento y el repunte sobra.
 *
 * - Esta el id nuevo y no el viejo: el renombrado subio. Se mueven.
 * - Estan los dos: alguien ha vuelto a usar el id viejo para otra fase. Las
 *   decisiones apuntan a una fase que existe, asi que moverlas seria peor que
 *   dejarlas. Se descarta.
 * - No esta el nuevo: el renombrado ya no esta en el documento —se deshizo, o
 *   se resolvio un conflicto quedandose con la copia del servidor—. Se descarta.
 */
export function queHacerSegunElDocumento(
  repunte: RepuntePendiente,
  idsDelDocumento: readonly string[],
): 'repuntar' | 'descartar' {
  const tieneNuevo = idsDelDocumento.includes(repunte.idNuevo)
  const tieneViejo = idsDelDocumento.includes(repunte.idViejo)
  return tieneNuevo && !tieneViejo ? 'repuntar' : 'descartar'
}

/**
 * Como queda la cola despues de intentar los repuntes.
 *
 * Los que fallan **se quedan**, para reintentarlos en el guardado siguiente o
 * en la proxima apertura del proyecto. Los que se descartan y los que salen
 * bien se van. Es la otra mitad de "en silencio no": ademas de avisar en
 * pantalla, el trabajo pendiente no se pierde.
 */
export function colaDespuesDeIntentar(
  pendientes: readonly RepuntePendiente[],
  resultado: (repunte: RepuntePendiente) => 'hecho' | 'fallo' | 'descartado',
): RepuntePendiente[] {
  return pendientes.filter((repunte) => resultado(repunte) === 'fallo')
}
