export type DecisionEstado = 'activa' | 'inactiva'

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
  estado: DecisionEstado
  /** Solo en las inactivas: por que se quito y cual ocupa su sitio. */
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
  estado: DecisionEstado
  motivo_inactivacion: string | null
  sustituida_por: string | null
  created_at: string
  updated_at: string
}
