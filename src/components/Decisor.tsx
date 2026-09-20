import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import {
  documentoDesdeFilas,
  stringifyDecisionesJson,
  temasSugeridos,
} from '../lib/decisiones-document'
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

const borradorVacio = (): Borrador => ({
  decidido: '',
  fecha: new Date().toISOString().slice(0, 10),
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
  const [inactivando, setInactivando] = useState(false)
  const [motivoBaja, setMotivoBaja] = useState('')
  const [sustituta, setSustituta] = useState('')

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
    setMotivoBaja('')
    setSustituta('')
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

  const candidatasASustituir = useMemo(
    () => decisiones.filter((fila) => fila.estado === 'activa' && fila.id !== actual?.id),
    [actual, decisiones],
  )

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
    const { data, error: fallo } = await cliente
      .from('decisiones')
      .insert({
        project_id: projectId,
        decidido: borrador.decidido.trim(),
        fecha: borrador.fecha,
        motivo: borrador.motivo.trim(),
        tema: borrador.tema.trim(),
        detalle: borrador.detalle.trim() || null,
        nodo_id: borrador.nodo.trim() || null,
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

    const { data, error: fallo } = await cliente
      .from('decisiones')
      .update({
        decidido: borrador.decidido.trim(),
        fecha: borrador.fecha,
        motivo: borrador.motivo.trim(),
        tema: borrador.tema.trim(),
        detalle: borrador.detalle.trim() || null,
        nodo_id: borrador.nodo.trim() || null,
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

  async function inactivar() {
    if (!actual) return
    if (!motivoBaja.trim()) {
      setError('Di por que se quita.')
      return
    }
    if (!sustituta) {
      setError('Elige la decision que ocupa su sitio.')
      return
    }

    setInactivando(true)
    setError('')

    const { data, error: fallo } = await cliente
      .from('decisiones')
      .update({
        estado: 'inactiva',
        motivo_inactivacion: motivoBaja.trim(),
        sustituida_por: sustituta,
      })
      .eq('id', actual.id)
      .select('*')
      .single()

    setInactivando(false)
    if (fallo) {
      setError(fallo.message)
      return
    }

    setDecisiones((lista) =>
      lista.map((fila) => (fila.id === actual.id ? (data as DecisionFila) : fila)),
    )
    setMotivoBaja('')
    setSustituta('')
    setAviso('Inactivada.')
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

            <label className="decisor-campo">
              Que se decidio
              <textarea
                onChange={(evento) => setBorrador({ ...borrador, decidido: evento.target.value })}
                placeholder="Con tus palabras. Texto plano."
                rows={4}
                value={borrador.decidido}
              />
            </label>

            <div className="decisor-fila">
              <label className="decisor-campo">
                Fecha en que se decidio
                <input
                  onChange={(evento) => setBorrador({ ...borrador, fecha: evento.target.value })}
                  type="date"
                  value={borrador.fecha}
                />
              </label>
              <label className="decisor-campo">
                Tema
                <input
                  list="decisor-temas"
                  onChange={(evento) => setBorrador({ ...borrador, tema: evento.target.value })}
                  placeholder="arquitectura, producto, proceso..."
                  value={borrador.tema}
                />
                <datalist id="decisor-temas">
                  {[...new Set([...decisiones.map((fila) => fila.tema), ...temasSugeridos])].map(
                    (tema) => (
                      <option key={tema} value={tema} />
                    ),
                  )}
                </datalist>
              </label>
            </div>

            <label className="decisor-campo">
              Por que
              <textarea
                onChange={(evento) => setBorrador({ ...borrador, motivo: evento.target.value })}
                placeholder="El motivo, para que dentro de un ano se entienda."
                rows={3}
                value={borrador.motivo}
              />
            </label>

            <div className="decisor-fila">
              <label className="decisor-campo">
                Donde esta el detalle
                <input
                  onChange={(evento) => setBorrador({ ...borrador, detalle: evento.target.value })}
                  placeholder="Un acta, un documento, una direccion. Opcional."
                  value={borrador.detalle}
                />
              </label>
              <label className="decisor-campo">
                Fase del roadmap
                <input
                  onChange={(evento) => setBorrador({ ...borrador, nodo: evento.target.value })}
                  placeholder="SP1.3, si toca alguna. Opcional."
                  value={borrador.nodo}
                />
              </label>
            </div>

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
                  <span className="muted decisor-nota">
                    Corregir deja dicho lo que decia antes. No se borra nada.
                  </span>
                </>
              )}
            </div>

            {actual ? (
              <p className="muted decisor-fechas">
                Escrita el {formatearMomento(actual.created_at)}
                {actual.updated_at > actual.created_at
                  ? ` · tocada por ultima vez el ${formatearMomento(actual.updated_at)}`
                  : ''}
              </p>
            ) : null}

            {actual?.estado === 'activa' ? (
              <details className="decisor-inactivar">
                <summary>Inactivar esta decision</summary>
                <p className="modal-hint">
                  Una decision se quita porque otra ocupa su sitio. Las dos cosas son
                  obligatorias: por que se quita, y cual la sustituye.
                </p>
                <label className="decisor-campo">
                  Por que se quita
                  <textarea
                    onChange={(evento) => setMotivoBaja(evento.target.value)}
                    rows={2}
                    value={motivoBaja}
                  />
                </label>
                <label className="decisor-campo">
                  Cual la sustituye
                  <select onChange={(evento) => setSustituta(evento.target.value)} value={sustituta}>
                    <option value="">Elige una decision activa</option>
                    {candidatasASustituir.map((fila) => (
                      <option key={fila.id} value={fila.id}>
                        {fila.numero} — {fila.decidido.slice(0, 60)}
                      </option>
                    ))}
                  </select>
                </label>
                {candidatasASustituir.length === 0 ? (
                  <p className="muted">
                    No hay ninguna otra decision activa que pueda ocupar su sitio. Escribe
                    antes la que la sustituye.
                  </p>
                ) : null}
                <button
                  disabled={inactivando || candidatasASustituir.length === 0}
                  onClick={inactivar}
                  type="button"
                >
                  {inactivando ? 'Inactivando...' : 'Inactivar'}
                </button>
              </details>
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
    </section>
  )
}
