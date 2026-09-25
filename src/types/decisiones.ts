export type DecisionEstado = 'activa' | 'inactiva'

/**
 * La norma que recoge una decision: el documento del repositorio y, si hace
 * falta afinar, el apartado dentro de el.
 *
 * Vale en los dos estados y quiere decir cosas distintas en cada uno. En una
 * decision activa dice "esto ya esta escrito ahi", que es lo que permite ver
 * de un vistazo que parte del decisor esta recogida en una norma y que parte
 * no. En una inactiva sin sustituta, es la norma la que ocupa su sitio.
 *
 * El apartado es opcional: hay documentos cortos que recogen una decision
 * enteros. Lo que no puede haber es apartado sin documento.
 */
export type DecisionNorma = {
  documento: string
  apartado: string | null
}

/**
 * Una correccion, tal y como la guarda el disparador de la base. No se escribe
 * desde ningun sitio: aparece sola cuando una decision cambia.
 */
export type DecisionCorreccion = {
  campo: string
  antes: string | null
  despues: string | null
  cuando: string
}

/**
 * Una decision, como sale de la base y como se lee desde fuera.
 *
 * El numero es la identidad de cara afuera; el uuid de la fila no sale nunca.
 * Por eso "sustituida_por" es un numero y no un identificador: quien lee el
 * decisor tiene que poder decir "la 4 la sustituye la 12" sin mas.
 */
export type Decision = {
  numero: number
  /** Que se decidio, con las palabras de Ruben. Texto plano. */
  decidido: string
  /** La fecha del hecho, AAAA-MM-DD. No es cuando se escribio. */
  fecha: string
  motivo: string
  tema: string
  detalle: string | null
  /** Id del nodo del roadmap al que toca, si toca alguno. */
  nodo: string | null
  /** La norma que la recoge, si alguna la recoge. */
  norma: DecisionNorma | null
  estado: DecisionEstado
  /**
   * Solo en las inactivas: por que se quito y cual ocupa su sitio.
   *
   * "sustituida_por" nulo no es un hueco: quiere decir que lo que ocupa su
   * sitio no es otra decision sino la norma, que esta en "norma".
   */
  inactivacion: { motivo: string; sustituida_por: number | null } | null
  escrita_el: string
  corregida_el: string | null
  correcciones: DecisionCorreccion[]
}

export type DecisionesDocument = {
  schemaVersion: 1
  project: {
    id: string
    name: string
  }
  decisiones: Decision[]
}

/** Una fila del rastro, tal y como vive en decisiones_historial. */
export type DecisionHistorialFila = {
  id: string
  decision_id: string
  campo: string
  antes: string | null
  despues: string | null
  cambiado_el: string
}

/** La fila tal y como vive en la tabla. Solo la aplicacion la ve asi. */
export type DecisionFila = {
  id: string
  project_id: string
  numero: number
  decidido: string
  fecha: string
  motivo: string
  tema: string
  detalle: string | null
  nodo_id: string | null
  norma_documento: string | null
  norma_apartado: string | null
  estado: DecisionEstado
  motivo_inactivacion: string | null
  sustituida_por: string | null
  created_at: string
  updated_at: string
}
