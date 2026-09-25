import { supabase } from './supabase'

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

/** Cuantas decisiones del proyecto citan esta fase. Solo cuenta; no escribe. */
export async function contarDecisionesDelNodo(projectId: string, nodoId: string) {
  const cliente = supabase
  if (!cliente || !nodoId) return 0

  const { count, error } = await cliente
    .from('decisiones')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('nodo_id', nodoId)

  // Un fallo al contar no puede impedir el renombrado: el arbol es de Ruben y
  // la pregunta era una cortesia. Se devuelve 0 y se renombra sin preguntar.
  if (error) return 0
  return count ?? 0
}

/**
 * Repunta a la fase nueva las decisiones que citaban la vieja.
 *
 * Devuelve el mensaje de error si la base lo rechaza, o null si fue bien. El
 * roadmap ya se habra renombrado para entonces: si esto falla, lo que queda es
 * lo mismo que si Ruben hubiera contestado que no, y eso se puede arreglar a
 * mano desde el decisor.
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
