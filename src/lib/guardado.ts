/**
 * Que hacer cuando vuelve un guardado.
 *
 * Esta aqui, y suelto, porque es la unica parte del autoguardado que se puede
 * mirar de frente: dado lo que se mando, lo que hay en pantalla ahora mismo y
 * la fila que devolvio el servidor, decidir con que documento quedarse, con
 * que sello, y si queda algo pendiente de subir.
 *
 * El caso que obliga a escribirlo: un guardado de este roadmap ha llegado a
 * tardar seis segundos. Lo que se teclee durante esos seis segundos no estaba
 * en lo que se mando, y hasta ahora la respuesta del servidor lo borraba del
 * estado y de la cache, y encima dejaba el indicador en "Guardado". Se perdia
 * el trabajo y ademas la pantalla decia que estaba a salvo.
 */
import type { RoadmapDocument, RoadmapProject } from '../types/roadmap'
import { stringifyRoadmapJson } from './roadmap-document'

export function mismoDocumento(uno: RoadmapDocument, otro: RoadmapDocument) {
  return stringifyRoadmapJson(uno) === stringifyRoadmapJson(otro)
}

export type ResueltoElGuardado = {
  /** El documento con el que quedarse: el del servidor, o el de pantalla. */
  document: RoadmapDocument
  /** Siempre el sello que devolvio el servidor: es la version que hay arriba. */
  updated_at: string
  /**
   * 'synced' cuando no quedo nada pendiente. 'local' cuando se tecleo durante
   * el vuelo, para que el autoguardado vuelva a salir —ahora con el sello
   * nuevo, que es el unico que la guarda va a aceptar.
   */
  estado: 'local' | 'synced'
  /** Para poder decirlo en una prueba sin mirar por dentro. */
  huboCambiosDuranteElVuelo: boolean
}

/**
 * `enviado` es el documento que viajo en la peticion. `enPantalla` es el que
 * hay ahora, que puede ser el mismo o traer lo que se haya tecleado despues.
 * `fila` es lo que devolvio el servidor.
 *
 * Del servidor se coge siempre el sello, y el documento solo cuando nadie ha
 * escrito entretanto. Al reves seria volver a perder lo tecleado.
 */
export function resolverGuardado(
  enviado: RoadmapDocument,
  enPantalla: RoadmapDocument,
  fila: RoadmapProject,
): ResueltoElGuardado {
  if (mismoDocumento(enPantalla, enviado)) {
    return {
      document: fila.document,
      updated_at: fila.updated_at,
      estado: 'synced',
      huboCambiosDuranteElVuelo: false,
    }
  }

  return {
    document: enPantalla,
    updated_at: fila.updated_at,
    estado: 'local',
    huboCambiosDuranteElVuelo: true,
  }
}
