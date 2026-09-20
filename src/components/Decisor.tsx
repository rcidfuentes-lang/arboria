import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from './Icon'
import {
  documentoDesdeFilas,
  stringifyDecisionesJson,
  temasSugeridos,
} from '../lib/decisiones-document'
import { ejemploDeFichero, leerFicheroDeDecisiones } from '../lib/decisiones-import'
import type { PlanDeImportacion } from '../lib/decisiones-import'
import { supabase } from '../lib/supabase'
import type { DecisionFila, DecisionHistorialFila } from '../types/decisiones'

/**
 * El decisor: la lista de decisiones de un proyecto.
 *
 * Ocupa el sitio que tenia la vista de Ideas. Vive en su propio componente y
 * no dentro de RoadmapEditor porque no comparte nada con el: ni el arbol, ni
 * el guardado, ni el estado. Lo unico que comparte es el conmutador de vistas.
 *
 * Aqui se escribe. Todo lo demas —la API, el conector— solo lee.
 *
 * Dos cosas que este componente hace distinto del editor del roadmap, y a
 * proposito:
 *
 * - No guarda solo. El roadmap se sincroniza a los 900 ms de dejar de teclear
 *   porque una fase a medio escribir no tiene consecuencias. Aqui cada guardado
 *   es un registro permanente, y corregir deja rastro: guardar tiene que ser un
 *   acto, no un efecto de haber tecleado.
 * - No guarda en localStorage. Una decision a medias no es una decision, y una
 *   copia local que nadie ha confirmado no debe parecerse a una que si.
 *
 * La pantalla separa dos cosas que no son la misma y que antes estaban una
 * debajo de otra: corregir lo que una decision dice, y retirarla porque otra
 * ocupa su sitio. Lo primero se hace en el formulario; lo segundo, en un modal
 * que pide de una vez las dos cosas que hacen falta.
 */

type DecisorProps = {
  projectId: string
  proyecto: { id: string; name: string }
}

type Borrador = {
  decidido: string
  fecha: string
  motivo: string
  tema: string
  detalle: string
  nodo: string
}

const hoy = () => new Date().toISOString().slice(0, 10)

const borradorVacio = (): Borrador => ({
  decidido: '',
  fecha: hoy(),
  motivo: '',
  tema: '',
  detalle: '',
  nodo: '',
})

function borradorDe(fila: DecisionFila): Borrador {
  return {
    decidido: fila.decidido,
    fecha: fila.fecha,
    motivo: fila.motivo,
    tema: fila.tema,
    detalle: fila.detalle ?? '',
    nodo: fila.nodo_id ?? '',
  }
}

/**
 * El punto de partida de la decision que sustituye a otra: lo que decia la
 * vieja, con la fecha de hoy. Casi siempre la nueva es la vieja con un cambio,
 * y copiarla a mano para cambiar una linea es trabajo que no dice nada. La
 * fecha no se hereda porque la fecha es la del hecho, y el hecho es de hoy.
 */
function borradorHeredado(fila: DecisionFila): Borrador {
  return { ...borradorDe(fila), fecha: hoy() }
}

function mismoBorrador(uno: Borrador, otro: Borrador) {
  return (
    uno.decidido === otro.decidido &&
    uno.fecha === otro.fecha &&
    uno.motivo === otro.motivo &&
    uno.tema === otro.tema &&
    uno.detalle === otro.detalle &&
    uno.nodo === otro.nodo
  )
}

function faltaAlgo(borrador: Borrador) {
  if (!borrador.decidido.trim()) return 'Escribe que se decidio.'
  if (!borrador.fecha) return 'Pon la fecha en que se decidio.'
  if (!borrador.motivo.trim()) return 'Escribe por que.'
  if (!borrador.tema.trim()) return 'Pon un tema, para poder buscarla luego.'
  return ''
}

/** Lo que se manda a la base: lo mismo, recortado y con los vacios a nulo. */
function comoSeEscribe(borrador: Borrador) {
  return {
    decidido: borrador.decidido.trim(),
    fecha: borrador.fecha,
    motivo: borrador.motivo.trim(),
    tema: borrador.tema.trim(),
    detalle: borrador.detalle.trim() || null,
    nodo: borrador.nodo.trim() || null,
  }
}

function formatearFecha(valor: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(`${valor}T00:00:00`))
}

function formatearMomento(valor: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(valor),
  )
}

const nombreDelCampo: Record<string, string> = {
  decidido: 'Que se decidio',
  fecha: 'Fecha',
  motivo: 'Motivo',
  tema: 'Tema',
  detalle: 'Detalle',
  nodo_id: 'Fase del roadmap',
  estado: 'Estado',
  motivo_inactivacion: 'Motivo de la inactivacion',
  sustituida_por: 'Decision que la sustituye',
}

function descargar(nombre: string, texto: string) {
  const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }))
  const enlace = window.document.createElement('a')
  enlace.href = url
  enlace.download = nombre
  enlace.click()
  URL.revokeObjectURL(url)
}

/**
 * Los campos de una decision. Son los mismos se escriba donde se escriba: en
 * el formulario de la pantalla o dentro del modal de retirada. Estan aqui en
 * un sitio y no en dos porque "la sustituta se escribe entera, y sus campos
 * son los de cualquier decision" solo es verdad si de verdad son los mismos.
 */
function CamposDeDecision({
  borrador,
  cambiar,
  idDeTemas,
  temas,
}: {
  borrador: Borrador
  cambiar: (borrador: Borrador) => void
  idDeTemas: string
  temas: string[]
}) {
  return (
    <>
      <label className="decisor-campo">
        Que se decidio
        <textarea
          onChange={(evento) => cambiar({ ...borrador, decidido: evento.target.value })}
          placeholder="Con tus palabras. Texto plano."
          rows={4}
          value={borrador.decidido}
        />
      </label>

      <div className="decisor-fila">
        <label className="decisor-campo">
          Fecha en que se decidio
          <input
            onChange={(evento) => cambiar({ ...borrador, fecha: evento.target.value })}
            type="date"
            value={borrador.fecha}
          />
        </label>
        <label className="decisor-campo">
          Tema
          <input
            list={idDeTemas}
            onChange={(evento) => cambiar({ ...borrador, tema: evento.target.value })}
            placeholder="arquitectura, producto, proceso..."
            value={borrador.tema}
          />
          <datalist id={idDeTemas}>
            {temas.map((tema) => (
              <option key={tema} value={tema} />
            ))}
          </datalist>
        </label>
      </div>

      <label className="decisor-campo">
        Por que
        <textarea
          onChange={(evento) => cambiar({ ...borrador, motivo: evento.target.value })}
          placeholder="El motivo, para que dentro de un ano se entienda."
          rows={3}
          value={borrador.motivo}
        />
      </label>

      <div className="decisor-fila">
        <label className="decisor-campo">
          Donde esta el detalle
          <input
            onChange={(evento) => cambiar({ ...borrador, detalle: evento.target.value })}
            placeholder="Un acta, un documento, una direccion. Opcional."
            value={borrador.detalle}
          />
        </label>
        <label className="decisor-campo">
          Fase del roadmap
          <input
            onChange={(evento) => cambiar({ ...borrador, nodo: evento.target.value })}
            placeholder="SP1.3, si toca alguna. Opcional."
            value={borrador.nodo}
          />
        </label>
      </div>
    </>
  )
}

export function Decisor({ projectId, proyecto }: DecisorProps) {
  const [decisiones, setDecisiones] = useState<DecisionFila[]>([])
  const [historial, setHistorial] = useState<DecisionHistorialFila[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [seleccionada, setSeleccionada] = useState<string | null>(null)
  const [escribiendoNueva, setEscribiendoNueva] = useState(false)
  const [borrador, setBorrador] = useState<Borrador>(borradorVacio)
  const [guardando, setGuardando] = useState(false)

  // La retirada, entera: se abre, se rellena y se acepta sin salir del modal.
  const [retirando, setRetirando] = useState(false)
  const [errorBaja, setErrorBaja] = useState('')
  const [inactivando, setInactivando] = useState(false)
  const [motivoBaja, setMotivoBaja] = useState('')
  const [comoSustituye, setComoSustituye] = useState<'nueva' | 'existente'>('nueva')
  const [borradorSustituta, setBorradorSustituta] = useState<Borrador>(borradorVacio)
  const [sustituta, setSustituta] = useState('')
  const [busquedaSustituta, setBusquedaSustituta] = useState('')

  const [importando, setImportando] = useState(false)
  const [mostrarImport, setMostrarImport] = useState(false)
  const [textoImport, setTextoImport] = useState('')
  const [nombreFichero, setNombreFichero] = useState('')
  const [erroresImport, setErroresImport] = useState<string[]>([])
  const [plan, setPlan] = useState<PlanDeImportacion | null>(null)

  const cliente = supabase!

  const cargar = useCallback(async () => {
    setError('')
    setCargando(true)

    const lista = await cliente
      .from('decisiones')
      .select('*')
      .eq('project_id', projectId)
      .order('numero', { ascending: true })

    if (lista.error) {
      setError(lista.error.message)
      setCargando(false)
      return
    }

    const filas = (lista.data ?? []) as DecisionFila[]
    setDecisiones(filas)

    // El rastro se trae aparte porque es otra tabla y porque la aplicacion
    // solo puede leerlo: lo escribe un disparador.
    const rastro = filas.length
      ? await cliente
          .from('decisiones_historial')
          .select('*')
          .in('decision_id', filas.map((fila) => fila.id))
          .order('cambiado_el', { ascending: true })
      : { data: [], error: null }

    if (rastro.error) setError(rastro.error.message)
    else setHistorial((rastro.data ?? []) as DecisionHistorialFila[])

    setCargando(false)
  }, [cliente, projectId])

  useEffect(() => {
    cargar()
  }, [cargar])

  const actual = useMemo(
    () => decisiones.find((fila) => fila.id === seleccionada) ?? null,
    [decisiones, seleccionada],
  )

  useEffect(() => {
    setBorrador(actual ? borradorDe(actual) : borradorVacio())
    setAviso('')
  }, [actual])

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase()
    if (!texto) return decisiones
    return decisiones.filter((fila) =>
      [fila.decidido, fila.motivo, fila.tema, fila.detalle ?? '', fila.nodo_id ?? '', `${fila.numero}`]
        .join(' ')
        .toLowerCase()
        .includes(texto),
    )
  }, [busqueda, decisiones])

  const numeroDe = useMemo(
    () => new Map(decisiones.map((fila) => [fila.id, fila.numero])),
    [decisiones],
  )

  const temas = useMemo(
    () => [...new Set([...decisiones.map((fila) => fila.tema), ...temasSugeridos])],
    [decisiones],
  )

  const candidatasASustituir = useMemo(
    () => decisiones.filter((fila) => fila.estado === 'activa' && fila.id !== actual?.id),
    [actual, decisiones],
  )

  /** Las candidatas que quedan al buscar, por texto y por numero. */
  const candidatasVisibles = useMemo(() => {
    const texto = busquedaSustituta.trim().toLowerCase()
    if (!texto) return candidatasASustituir
    return candidatasASustituir.filter((fila) =>
      [fila.decidido, fila.motivo, fila.tema, fila.nodo_id ?? '', `${fila.numero}`]
        .join(' ')
        .toLowerCase()
        .includes(texto),
    )
  }, [busquedaSustituta, candidatasASustituir])

  const cambiada = actual ? !mismoBorrador(borrador, borradorDe(actual)) : true

  function abrirNueva() {
    setSeleccionada(null)
    setEscribiendoNueva(true)
    setBorrador(borradorVacio())
    setError('')
    setAviso('')
  }

  function abrir(fila: DecisionFila) {
    setEscribiendoNueva(false)
    setSeleccionada(fila.id)
    setError('')
  }

  async function guardarNueva() {
    const falta = faltaAlgo(borrador)
    if (falta) {
      setError(falta)
      return
    }

    setGuardando(true)
    setError('')

    // El numero no se manda: lo pone la base, consecutivo por proyecto.
    const campos = comoSeEscribe(borrador)
    const { data, error: fallo } = await cliente
      .from('decisiones')
      .insert({
        project_id: projectId,
        decidido: campos.decidido,
        fecha: campos.fecha,
        motivo: campos.motivo,
        tema: campos.tema,
        detalle: campos.detalle,
        nodo_id: campos.nodo,
      })
      .select('*')
      .single()

    setGuardando(false)
    if (fallo) {
      setError(fallo.message)
      return
    }

    const creada = data as DecisionFila
    setDecisiones((lista) => [...lista, creada].sort((una, otra) => una.numero - otra.numero))
    setEscribiendoNueva(false)
    setSeleccionada(creada.id)
    setAviso(`Guardada como decision ${creada.numero}.`)
  }

  async function guardarCorreccion() {
    if (!actual) return
    const falta = faltaAlgo(borrador)
    if (falta) {
      setError(falta)
      return
    }

    setGuardando(true)
    setError('')

    const campos = comoSeEscribe(borrador)
    const { data, error: fallo } = await cliente
      .from('decisiones')
      .update({
        decidido: campos.decidido,
        fecha: campos.fecha,
        motivo: campos.motivo,
        tema: campos.tema,
        detalle: campos.detalle,
        nodo_id: campos.nodo,
      })
      .eq('id', actual.id)
      .select('*')
      .single()

    setGuardando(false)
    if (fallo) {
      setError(fallo.message)
      return
    }

    setDecisiones((lista) =>
      lista.map((fila) => (fila.id === actual.id ? (data as DecisionFila) : fila)),
    )
    setAviso('Corregida. Queda dicho lo que decia antes.')
    // El rastro lo acaba de escribir el disparador, asi que hay que traerlo.
    cargar()
  }

  /**
   * Retirar una decision son dos escrituras que solo valen juntas, asi que el
   * modal las pide juntas y la base las hace juntas. Aqui se abre con el texto
   * de la que se retira ya puesto, que es de donde casi siempre se parte.
   */
  function abrirRetirada() {
    if (!actual) return
    setRetirando(true)
    setErrorBaja('')
    setMotivoBaja('')
    setComoSustituye('nueva')
    setBorradorSustituta(borradorHeredado(actual))
    setSustituta('')
    setBusquedaSustituta('')
  }

  async function retirar() {
    if (!actual) return

    if (!motivoBaja.trim()) {
      setErrorBaja('Di por que se retira.')
      return
    }

    if (comoSustituye === 'nueva') {
      const falta = faltaAlgo(borradorSustituta)
      if (falta) {
        setErrorBaja(`En la decision que la sustituye: ${falta.toLowerCase()}`)
        return
      }
    } else if (!sustituta) {
      setErrorBaja('Elige la decision que ocupa su sitio, o escribela aqui mismo.')
      return
    }

    setInactivando(true)
    setErrorBaja('')

    // Una sola llamada: o nace la nueva y la vieja queda inactiva apuntando a
    // ella, o no se escribe nada. Las dos cosas en dos llamadas desde aqui
    // dejarian la nueva escrita si fallase la segunda.
    const { data, error: fallo } = await cliente.rpc('inactivar_decision', {
      proyecto: projectId,
      decision: actual.id,
      por_que: motivoBaja.trim(),
      sustituta: comoSustituye === 'existente' ? sustituta : null,
      nueva: comoSustituye === 'nueva' ? comoSeEscribe(borradorSustituta) : null,
    })

    setInactivando(false)
    if (fallo) {
      setErrorBaja(`No se ha escrito nada. ${fallo.message}`)
      return
    }

    const resumen = (data ?? {}) as { retirada?: number; sustituta?: number; creada?: boolean }
    setRetirando(false)
    setAviso(
      resumen.creada
        ? `La decision ${resumen.retirada} queda inactiva. La sustituye la ${resumen.sustituta}, que se acaba de escribir.`
        : `La decision ${resumen.retirada} queda inactiva. La sustituye la ${resumen.sustituta}.`,
    )
    cargar()
  }

  function abrirImport() {
    setMostrarImport(true)
    setTextoImport('')
    setNombreFichero('')
    setErroresImport([])
    setPlan(null)
    setError('')
    setAviso('')
  }

  /**
   * Leer el fichero no escribe nada: deja el plan a la vista para que Ruben
   * vea que va a entrar antes de que entre. Los errores salen todos juntos,
   * que es lo que sirve cuando el fichero se ha escrito a mano.
   */
  function revisar(texto: string) {
    setTextoImport(texto)
    setErroresImport([])
    setPlan(null)
    if (!texto.trim()) return

    const leido = leerFicheroDeDecisiones(
      texto,
      decisiones.map((fila) => ({
        numero: fila.numero,
        decidido: fila.decidido,
        fecha: fila.fecha,
      })),
    )
    if (leido.ok) setPlan(leido.plan)
    else setErroresImport(leido.errores)
  }

  async function tomarFichero(evento: ChangeEvent<HTMLInputElement>) {
    const fichero = evento.target.files?.[0]
    if (!fichero) return
    setNombreFichero(fichero.name)
    revisar(await fichero.text())
  }

  async function importar() {
    if (!plan) return
    setImportando(true)
    setErroresImport([])

    // Una sola llamada: la base mete el fichero entero en una transaccion, con
    // sus altas y sus inactivaciones, o no mete nada.
    const { data, error: fallo } = await cliente.rpc('importar_decisiones', {
      proyecto: projectId,
      entradas: plan.entradas,
    })

    setImportando(false)
    if (fallo) {
      setErroresImport([`No se ha importado nada. ${fallo.message}`])
      return
    }

    const resumen = (data ?? {}) as { escritas?: number; omitidas?: number; inactivadas?: number }
    setMostrarImport(false)
    setSeleccionada(null)
    setEscribiendoNueva(false)
    setAviso(
      `Importadas ${resumen.escritas ?? 0}` +
        `${resumen.inactivadas ? `, ${resumen.inactivadas} inactivadas` : ''}` +
        `${resumen.omitidas ? `, ${resumen.omitidas} ya estaban y se han dejado como estaban` : ''}.`,
    )
    cargar()
  }

  function exportar() {
    const documento = documentoDesdeFilas(decisiones, proyecto, historial)
    descargar(`${proyecto.id || 'proyecto'}-decisiones.json`, stringifyDecisionesJson(documento))
  }

  const rastroDeLaActual = useMemo(
    () =>
      historial
        .filter((fila) => fila.decision_id === actual?.id)
        .sort((una, otra) => otra.cambiado_el.localeCompare(una.cambiado_el)),
    [actual, historial],
  )

  return (
    <section className="decisor no-print" aria-label="Decisiones">
      <aside className="decisor-lista-panel">
        <div className="decisor-lista-toolbar">
          <div>
            <h2>Decisiones</h2>
            <p>
              {decisiones.length} escritas
              {decisiones.some((fila) => fila.estado === 'inactiva')
                ? `, ${decisiones.filter((fila) => fila.estado === 'activa').length} activas`
                : ''}
            </p>
          </div>
          <input
            aria-label="Buscar decisiones"
            onChange={(evento) => setBusqueda(evento.target.value)}
            placeholder="Buscar"
            type="search"
            value={busqueda}
          />
          <button aria-label="Nueva decision" className="icon-only" onClick={abrirNueva} title="Nueva decision" type="button">
            <Icon name="plus" />
          </button>
          <button
            aria-label="Importar decisiones"
            className="icon-only secondary-button"
            onClick={abrirImport}
            title="Importar decisiones de un fichero"
            type="button"
          >
            <Icon name="upload" />
          </button>
          <button
            aria-label="Exportar decisiones"
            className="icon-only secondary-button"
            disabled={decisiones.length === 0}
            onClick={exportar}
            title="Exportar decisiones"
            type="button"
          >
            <Icon name="download" />
          </button>
        </div>

        {cargando ? <p className="muted">Cargando decisiones...</p> : null}

        {!cargando && decisiones.length === 0 ? (
          <p className="empty-state">
            Todavia no hay ninguna decision. La primera se escribe con el boton de arriba.
          </p>
        ) : null}

        {!cargando && decisiones.length > 0 && visibles.length === 0 ? (
          <p className="empty-state">No hay decisiones que coincidan.</p>
        ) : null}

        <ul className="decisor-lista">
          {visibles.map((fila) => (
            <li key={fila.id}>
              <button
                className={`${fila.id === seleccionada ? 'active' : ''} ${fila.estado === 'inactiva' ? 'inactiva' : ''}`}
                onClick={() => abrir(fila)}
                type="button"
              >
                <span className="decisor-numero">{fila.numero}</span>
                <span className="decisor-resumen">
                  <strong>{fila.decidido}</strong>
                  <span>
                    {fila.tema} · {formatearFecha(fila.fecha)}
                    {fila.estado === 'inactiva'
                      ? ` · inactiva, la sustituye la ${numeroDe.get(fila.sustituida_por ?? '') ?? '?'}`
                      : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="decisor-detalle-panel">
        {error ? <p className="form-error">{error}</p> : null}
        {aviso ? <p className="decisor-aviso">{aviso}</p> : null}

        {!escribiendoNueva && !actual ? (
          <div className="decisor-vacio">
            <h2>Decisiones</h2>
            <p className="empty-state">
              Elige una decision de la lista para leerla o corregirla, o escribe una nueva.
            </p>
            <button onClick={abrirNueva} type="button">
              <Icon name="plus" /> Nueva decision
            </button>
          </div>
        ) : null}

        {escribiendoNueva || actual ? (
          <>
            <div className="decisor-cabecera">
              <h2>
                {escribiendoNueva ? 'Nueva decision' : `Decision ${actual?.numero}`}
              </h2>
              {actual ? (
                <span className={`decisor-chip ${actual.estado}`}>{actual.estado}</span>
              ) : null}
              {actual ? (
                <p className="muted decisor-fechas">
                  Escrita el {formatearMomento(actual.created_at)}
                  {actual.updated_at > actual.created_at
                    ? ` · corregida el ${formatearMomento(actual.updated_at)}`
                    : ''}
                </p>
              ) : null}
            </div>

            {actual?.estado === 'inactiva' ? (
              <div className="decisor-baja">
                <p>
                  <strong>Inactiva.</strong> La sustituye la decision{' '}
                  {numeroDe.get(actual.sustituida_por ?? '') ?? '?'}.
                </p>
                <p className="muted">{actual.motivo_inactivacion}</p>
              </div>
            ) : null}

            {/* Lo que la decision dice, y el unico sitio desde el que cambia. */}
            <section className="decisor-bloque">
              <header className="decisor-bloque-cabecera">
                <h3>{escribiendoNueva ? 'Lo que se decide' : 'Lo que dice'}</h3>
                <p className="muted">
                  {escribiendoNueva
                    ? 'Al guardar nace una decision nueva, con el numero siguiente.'
                    : 'Guardar cambia lo que dice y deja escrito lo que decia antes. Sigue siendo la misma decision.'}
                </p>
              </header>

              <CamposDeDecision
                borrador={borrador}
                cambiar={setBorrador}
                idDeTemas="decisor-temas"
                temas={temas}
              />

              <div className="decisor-acciones">
                {escribiendoNueva ? (
                  <>
                    <button disabled={guardando} onClick={guardarNueva} type="button">
                      <Icon name="check" /> {guardando ? 'Guardando...' : 'Guardar la decision'}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setEscribiendoNueva(false)}
                      type="button"
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <button disabled={guardando || !cambiada} onClick={guardarCorreccion} type="button">
                      <Icon name="check" /> {guardando ? 'Guardando...' : 'Guardar la correccion'}
                    </button>
                    {cambiada ? (
                      <button
                        className="secondary-button"
                        onClick={() => actual && setBorrador(borradorDe(actual))}
                        type="button"
                      >
                        Descartar los cambios
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </section>

            {/* Retirarla es otra cosa, y por eso esta en otro sitio. */}
            {actual?.estado === 'activa' ? (
              <section className="decisor-bloque decisor-bloque-retirar">
                <header className="decisor-bloque-cabecera">
                  <h3>Retirarla</h3>
                  <p className="muted">
                    Deja de estar vigente. No se borra ni se toca lo que dice: queda apuntando a la
                    decision que ocupa su sitio.
                  </p>
                </header>
                <button className="secondary-button text-danger" onClick={abrirRetirada} type="button">
                  Inactivar la decision {actual.numero}
                </button>
              </section>
            ) : null}

            {rastroDeLaActual.length > 0 ? (
              <details className="decisor-rastro">
                <summary>Lo que decia antes ({rastroDeLaActual.length})</summary>
                <ul>
                  {rastroDeLaActual.map((fila) => (
                    <li key={fila.id}>
                      <p className="muted">
                        {nombreDelCampo[fila.campo] ?? fila.campo} ·{' '}
                        {formatearMomento(fila.cambiado_el)}
                      </p>
                      <p className="decisor-antes">{fila.antes ?? '(vacio)'}</p>
                      <p className="decisor-despues">{fila.despues ?? '(vacio)'}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </section>

      {retirando && actual ? (
        <div className="modal-backdrop">
          <section
            aria-labelledby="titulo-retirada"
            className="modal modal-retirada"
            role="dialog"
          >
            <div className="decisor-bloque-cabecera">
              <h2 id="titulo-retirada">Retirar la decision {actual.numero}</h2>
              <p className="modal-hint">
                Se retira porque otra ocupa su sitio. Las dos cosas se hacen de una vez: si algo
                falla no se escribe nada.
              </p>
            </div>

            <p className="decisor-retirada-cual">{actual.decidido}</p>

            <label className="decisor-campo">
              Por que se retira
              <textarea
                onChange={(evento) => {
                  setMotivoBaja(evento.target.value)
                  setErrorBaja('')
                }}
                placeholder="Lo que ha cambiado desde que se decidio."
                rows={2}
                value={motivoBaja}
              />
            </label>

            <div className="decisor-bloque-cabecera">
              <h3>La decision que la sustituye</h3>
            </div>

            <div className="retirada-modos" role="group" aria-label="La decision que la sustituye">
              <button
                aria-pressed={comoSustituye === 'nueva'}
                className={comoSustituye === 'nueva' ? 'active' : 'secondary-button'}
                onClick={() => {
                  setComoSustituye('nueva')
                  setErrorBaja('')
                }}
                type="button"
              >
                Escribirla aqui
              </button>
              <button
                aria-pressed={comoSustituye === 'existente'}
                className={comoSustituye === 'existente' ? 'active' : 'secondary-button'}
                onClick={() => {
                  setComoSustituye('existente')
                  setErrorBaja('')
                }}
                type="button"
              >
                Elegir una que ya existe
              </button>
            </div>

            {comoSustituye === 'nueva' ? (
              <>
                <div className="decisor-acciones">
                  <span className="muted decisor-nota">
                    Empieza con el texto de la {actual.numero}, para cambiar lo que cambie.
                  </span>
                  <button
                    className="secondary-button"
                    onClick={() => setBorradorSustituta(borradorVacio())}
                    type="button"
                  >
                    <Icon name="eraser" /> Empezar en blanco
                  </button>
                </div>
                <CamposDeDecision
                  borrador={borradorSustituta}
                  cambiar={(cambiado) => {
                    setBorradorSustituta(cambiado)
                    setErrorBaja('')
                  }}
                  idDeTemas="decisor-temas-sustituta"
                  temas={temas}
                />
              </>
            ) : (
              <>
                <input
                  aria-label="Buscar la decision que la sustituye"
                  onChange={(evento) => setBusquedaSustituta(evento.target.value)}
                  placeholder="Buscar por texto o por numero"
                  type="search"
                  value={busquedaSustituta}
                />
                {candidatasASustituir.length === 0 ? (
                  <p className="muted">
                    No hay ninguna otra decision activa. Escribe aqui la que la sustituye.
                  </p>
                ) : candidatasVisibles.length === 0 ? (
                  <p className="muted">No hay decisiones activas que coincidan.</p>
                ) : (
                  <ul className="decisor-lista retirada-candidatas">
                    {candidatasVisibles.map((fila) => (
                      <li key={fila.id}>
                        <button
                          aria-pressed={sustituta === fila.id}
                          className={sustituta === fila.id ? 'active' : ''}
                          onClick={() => {
                            setSustituta(fila.id)
                            setErrorBaja('')
                          }}
                          type="button"
                        >
                          <span className="decisor-numero">{fila.numero}</span>
                          <span className="decisor-resumen">
                            <strong>{fila.decidido}</strong>
                            <span>
                              {fila.tema} · {formatearFecha(fila.fecha)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {errorBaja ? <p className="form-error">{errorBaja}</p> : null}

            <div className="modal-actions">
              <button
                className="secondary-button"
                disabled={inactivando}
                onClick={() => setRetirando(false)}
                type="button"
              >
                Cancelar
              </button>
              <button disabled={inactivando} onClick={retirar} type="button">
                {inactivando
                  ? 'Escribiendo...'
                  : comoSustituye === 'nueva'
                    ? `Escribir la nueva y retirar la ${actual.numero}`
                    : `Retirar la ${actual.numero}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {mostrarImport ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h2>Importar decisiones</h2>
            <p className="modal-hint">
              Un fichero JSON que traes tu. No borra ni pisa nada: lo que ya este
              escrito se queda como esta. Si el fichero tiene un fallo no entra nada,
              y aqui abajo pone cual.
            </p>

            <label className="decisor-campo">
              Fichero
              <input accept="application/json,.json" onChange={tomarFichero} type="file" />
            </label>
            {nombreFichero ? <p className="muted">{nombreFichero}</p> : null}

            <details className="json-example">
              <summary>Ver el formato, con un ejemplo</summary>
              <p className="modal-hint">
                Obligatorios: <code>decidido</code>, <code>fecha</code> (AAAA-MM-DD),{' '}
                <code>motivo</code> y <code>tema</code>. Opcionales: <code>detalle</code> y{' '}
                <code>nodo</code>. Para retirar una decision, <code>inactiva</code> con su{' '}
                <code>motivo</code> y <code>sustituida_por</code>, que es el{' '}
                <code>ref</code> de otra entrada del mismo fichero o el numero de una
                decision ya escrita.
              </p>
              <pre>{ejemploDeFichero}</pre>
              <button className="secondary-button" onClick={() => revisar(ejemploDeFichero)} type="button">
                <Icon name="copy" /> Usar el ejemplo
              </button>
            </details>

            <label className="decisor-campo">
              O pegalo aqui
              <textarea
                aria-label="Pegar el fichero de decisiones"
                onChange={(evento) => revisar(evento.target.value)}
                rows={8}
                value={textoImport}
              />
            </label>

            {erroresImport.length > 0 ? (
              <div className="decisor-errores">
                <p className="form-error">No se importa nada. Hay {erroresImport.length} cosa(s) que arreglar:</p>
                <ul>
                  {erroresImport.map((mensaje) => (
                    <li key={mensaje}>{mensaje}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan ? (
              <div className="decisor-aviso">
                <p>
                  Se escribiran <strong>{plan.nuevas}</strong> decision(es)
                  {plan.inactivaciones > 0 ? `, ${plan.inactivaciones} de ellas inactivas` : ''}.
                </p>
                {plan.yaEstaban.length > 0 ? (
                  <p className="muted">
                    {plan.yaEstaban.length} ya estaban escritas y se dejan como estan:{' '}
                    {plan.yaEstaban.map((fila) => `la ${fila.numero}`).join(', ')}.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="modal-actions">
              <button disabled={!plan || importando || plan.nuevas === 0} onClick={importar} type="button">
                {importando ? 'Importando...' : 'Importar'}
              </button>
              <button className="secondary-button" onClick={() => setMostrarImport(false)} type="button">
                Cancelar
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
