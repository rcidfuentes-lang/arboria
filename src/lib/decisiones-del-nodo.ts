import { supabase } from './supabase'
import type { RepuntePendiente } from './orden-del-repunte'

/**
 * Lo poco que el roadmap necesita saber del decisor.
 *
 * El editor del arbol no conoce las decisiones y no tiene por que conocerlas:
 * son otra tabla y otra pantalla. Pero el id de una fase es el unico hilo que
 * une las dos cosas —una decision guarda `nodo_id` como texto, sin llave
 * ajena—, asi que renombrar una fase puede dejar huerfanas sus decisiones sin
 * que nadie se entere. Aqui esta lo justo para poder avisar y, si Ruben quiere,
 * arreglarlo en el mismo gesto.
 *
 * No se hace automatico a proposito. Que una decision siga a su fase es lo
 * normal, pero no siempre: un id se puede reutilizar para otra cosa, y entonces
 * arrastrar las decisiones seria peor que dejarlas. Lo decide quien renombra.
 */

export type DecisionesDelNodo = {
  total: number
  activas: number
  inactivas: number
}

const ninguna: DecisionesDelNodo = { total: 0, activas: 0, inactivas: 0 }

/**
 * Cuantas decisiones del proyecto citan esta fase, separando activas de
 * inactivas. Solo cuenta; no escribe.
 *
 * Las inactivas cuentan y se mueven igual que las activas: una decision
 * retirada sigue explicando por que se hizo lo que se hizo, y si se queda
 * apuntando a una fase que ya no existe deja de explicar nada. Se separan en la
 * cuenta para que quien renombra sepa que van tambien.
 */
export async function contarDecisionesDelNodo(
  projectId: string,
  nodoId: string,
): Promise<DecisionesDelNodo> {
  const cliente = supabase
  if (!cliente || !nodoId) return ninguna

  const { data, error } = await cliente
    .from('decisiones')
    .select('estado')
    .eq('project_id', projectId)
    .eq('nodo_id', nodoId)

  // Un fallo al contar no puede impedir el renombrado: el arbol es de Ruben y
  // la pregunta era una cortesia. Se devuelve cero y se renombra sin preguntar.
  if (error || !data) return ninguna

  const activas = data.filter((fila) => (fila as { estado: string }).estado === 'activa').length
  return { total: data.length, activas, inactivas: data.length - activas }
}

/**
 * Repunta a la fase nueva las decisiones que citaban la vieja. Activas e
 * inactivas, las dos.
 *
 * Esto se llama **despues** de que el roadmap este guardado en el servidor, no
 * antes: si se moviesen primero y el guardado del arbol fallara o diera
 * conflicto, en el servidor quedarian decisiones apuntando a un id que alli no
 * existe. Al reves, lo peor que pasa es que las decisiones se queden en el id
 * viejo, que es lo mismo que contestar "dejalas como estan" y se arregla a mano.
 *
 * Devuelve el mensaje de error si la base lo rechaza, o null si fue bien.
 */
export async function repuntarDecisionesDelNodo(
  projectId: string,
  nodoViejo: string,
  nodoNuevo: string,
) {
  const cliente = supabase
  if (!cliente) return 'No hay conexion con la base.'

  const { error } = await cliente
    .from('decisiones')
    .update({ nodo_id: nodoNuevo })
    .eq('project_id', projectId)
    .eq('nodo_id', nodoViejo)

  return error ? error.message : null
}

/**
 * La cola de repuntes pendientes de un proyecto, en localStorage.
 *
 * Vive al lado de la copia local del documento y se borra con ella, porque
 * cuenta lo mismo: hay un renombrado hecho aqui que todavia no ha cuajado del
 * todo. Sin esto, cerrar el proyecto antes de que terminara el guardado dejaba
 * el arbol renombrado en la cache —que se sube al reabrir— y las decisiones
 * huerfanas para siempre, porque el repunte solo vivia en memoria.
 */
function claveDeRepuntes(projectId: string) {
  return `arboria:repunte-pendiente:${projectId}`
}

export function leerRepuntes(projectId: string): RepuntePendiente[] {
  try {
    const crudo = localStorage.getItem(claveDeRepuntes(projectId))
    if (!crudo) return []
    const leido = JSON.parse(crudo)
    if (!Array.isArray(leido)) return []
    return leido.filter(
      (fila): fila is RepuntePendiente =>
        Boolean(fila) && typeof fila.idViejo === 'string' && typeof fila.idNuevo === 'string',
    )
  } catch {
    // Una entrada corrupta no puede llevarse por delante la pantalla.
    return []
  }
}

export function guardarRepuntes(projectId: string, pendientes: RepuntePendiente[]) {
  if (pendientes.length === 0) {
    localStorage.removeItem(claveDeRepuntes(projectId))
    return
  }
  localStorage.setItem(claveDeRepuntes(projectId), JSON.stringify(pendientes))
}

export function encolarRepunte(projectId: string, repunte: RepuntePendiente) {
  guardarRepuntes(projectId, [...leerRepuntes(projectId), repunte])
}

export function olvidarRepuntes(projectId: string) {
  localStorage.removeItem(claveDeRepuntes(projectId))
}
