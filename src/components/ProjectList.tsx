import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { RoadmapEditor } from './RoadmapEditor'
import { Icon } from './Icon'
import {
  normalizeRoadmapDocument,
  parseRoadmapJson,
  stringifyRoadmapJson,
} from '../lib/roadmap-document'
import { mismoDocumento, resolverGuardado } from '../lib/guardado'
import { supabase } from '../lib/supabase'
import type { RoadmapDocument, RoadmapProject } from '../types/roadmap'

type ProjectListProps = {
  session: Session
}

/**
 * Las dos copias de un proyecto cuando no se puede decidir cual vale.
 *
 * `al-abrir`: en este navegador hay una copia local que no sale de la version
 * que tiene hoy el servidor. `al-guardar`: al ir a escribir, la fila ya no
 * estaba como la dejamos, asi que alguien la movio mientras tanto.
 *
 * En los dos casos se para y se pregunta. Lo que no se hace es elegir por
 * silencio, que es lo que se hacia antes y siempre a favor de lo local.
 */
type Conflicto = {
  project: RoadmapProject
  documentoLocal: RoadmapDocument
  motivo: 'al-abrir' | 'al-guardar'
}

const initialDocument: RoadmapDocument = {
  schemaVersion: 1,
  project: {
    id: 'nuevo-proyecto',
    name: 'Nuevo proyecto',
  },
  ideas: [],
  nodes: [
    {
      id: '',
      title: 'Nueva fase',
      status: 'planned',
      content: '',
      children: [],
    },
  ],
}

function createSlug(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'nuevo-proyecto'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function localStorageKey(projectId: string) {
  return `arboria:roadmap-project:${projectId}`
}

/**
 * La copia local de un proyecto, y sobre que version del servidor se hizo.
 *
 * Antes aqui se guardaba el documento a pelo, y por eso no habia manera de
 * saber si una copia local era trabajo sin guardar —que hay que subir— o una
 * copia vieja de cuando el servidor iba por otro sitio —que no hay que subir
 * de ninguna manera—. `basadoEn` es el `updated_at` de la fila sobre la que se
 * empezo a editar, y es lo que distingue los dos casos.
 */
type CacheDeProyecto = {
  basadoEn: string
  document: RoadmapDocument
}

/**
 * Una copia del formato viejo no dice de cuando viene, asi que entra con
 * `basadoEn` vacio: no casa con ningun `updated_at` y se resuelve comparando
 * el texto, que es lo unico que se puede hacer con ella.
 *
 * Y va dentro de un try: hasta ahora una entrada corrupta reventaba el
 * JSON.parse y se llevaba por delante la pantalla entera.
 */
function leerCache(projectId: string): CacheDeProyecto | null {
  const crudo = localStorage.getItem(localStorageKey(projectId))
  if (!crudo) return null

  try {
    const leido = JSON.parse(crudo) as Record<string, unknown>
    if (!leido || typeof leido !== 'object') return null

    if (typeof leido.basadoEn === 'string' && leido.document) {
      return {
        basadoEn: leido.basadoEn,
        document: normalizeRoadmapDocument(leido.document as RoadmapDocument),
      }
    }

    return {
      basadoEn: '',
      document: normalizeRoadmapDocument(leido as unknown as RoadmapDocument),
    }
  } catch {
    return null
  }
}

function escribirCache(projectId: string, document: RoadmapDocument, basadoEn: string) {
  const cache: CacheDeProyecto = { basadoEn, document }
  localStorage.setItem(localStorageKey(projectId), JSON.stringify(cache))
}

function normalizeDocument(document: RoadmapDocument, project: RoadmapProject) {
  const normalizedDocument = normalizeRoadmapDocument(document)
  return {
    ...normalizedDocument,
    project: {
      id: normalizedDocument.project.id || project.slug,
      name: normalizedDocument.project.name || project.name,
    },
  }
}

function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = window.document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function ProjectList({ session }: ProjectListProps) {
  const [projects, setProjects] = useState<RoadmapProject[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [syncStatus, setSyncStatus] = useState<
    'local' | 'syncing' | 'synced' | 'error'
  >('synced')
  const [syncError, setSyncError] = useState('')
  const [conflicto, setConflicto] = useState<Conflicto | null>(null)
  /**
   * Lo que hay en pantalla ahora mismo, fuera del estado de React. El
   * autoguardado lo necesita al volver, y para entonces la variable que
   * capturo cuando salio ya no dice la verdad.
   */
  const documentoVivo = useRef<{ id: string; document: RoadmapDocument } | null>(null)
  /** Nunca dos escrituras del mismo proyecto a la vez: se pisarian el sello. */
  const guardando = useRef(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [projectImportText, setProjectImportText] = useState('')
  const [showProjectImport, setShowProjectImport] = useState(false)

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  )
  const supabaseClient = supabase!

  async function loadProjects() {
    setErrorMessage('')
    setIsLoading(true)

    const { data, error } = await supabaseClient
      .from('roadmap_projects')
      .select('*')
      .order('updated_at', { ascending: false })

    if (error) {
      setErrorMessage(error.message)
      setProjects([])
    } else {
      setProjects((data ?? []) as RoadmapProject[])
    }

    setIsLoading(false)
  }

  useEffect(() => {
    loadProjects()
  }, [])

  async function handleCreateProject() {
    setErrorMessage('')
    setIsCreating(true)

    const baseName = 'Nuevo proyecto'
    const slug = `${createSlug(baseName)}-${Date.now().toString(36)}`
    const document: RoadmapDocument = {
      ...initialDocument,
      project: {
        ...initialDocument.project,
        id: slug,
        name: baseName,
      },
    }

    const { data, error } = await supabaseClient
      .from('roadmap_projects')
      .insert({
        owner_id: session.user.id,
        name: baseName,
        slug,
        document,
      })
      .select('*')
      .single()

    if (error) {
      setErrorMessage(error.message)
    } else {
      const createdProject = data as RoadmapProject
      setProjects((currentProjects) => [createdProject, ...currentProjects])
      setActiveProjectId(createdProject.id)
    }

    setIsCreating(false)
  }

  async function handleImportProject(document: RoadmapDocument) {
    setErrorMessage('')
    setIsCreating(true)

    const baseName = document.project.name || 'Roadmap importado'
    const slug = `${createSlug(document.project.id || baseName)}-${Date.now().toString(36)}`
    const nextDocument: RoadmapDocument = {
      ...normalizeRoadmapDocument(document),
      project: {
        id: slug,
        name: baseName,
      },
    }

    const { data, error } = await supabaseClient
      .from('roadmap_projects')
      .insert({
        owner_id: session.user.id,
        name: baseName,
        slug,
        document: nextDocument,
      })
      .select('*')
      .single()

    if (error) {
      setErrorMessage(error.message)
    } else {
      const createdProject = data as RoadmapProject
      escribirCache(createdProject.id, createdProject.document, createdProject.updated_at)
      setProjects((currentProjects) => [createdProject, ...currentProjects])
      setActiveProjectId(createdProject.id)
      setProjectImportText('')
    }

    setIsCreating(false)
  }

  function handleImportTextAsProject() {
    const result = parseRoadmapJson(projectImportText)
    if (!result.document) {
      setErrorMessage(result.errors.join(' '))
      return
    }

    handleImportProject(result.document)
  }

  function handleDownloadProject(project: RoadmapProject) {
    downloadText(`${project.slug}.json`, stringifyRoadmapJson(normalizeDocument(project.document, project)))
  }

  function abrirCon(
    project: RoadmapProject,
    document: RoadmapDocument,
    estado: 'local' | 'synced',
  ) {
    // La fila que manda es la que se acaba de leer del servidor —de ahi salen
    // el updated_at que guarda la escritura siguiente y el nombre—, y encima
    // de ella va el documento que se haya elegido abrir.
    setProjects((currentProjects) =>
      currentProjects.map((currentProject) =>
        currentProject.id === project.id ? { ...project, document } : currentProject,
      ),
    )
    documentoVivo.current = { id: project.id, document }
    setActiveProjectId(project.id)
    setSyncError('')
    setSyncStatus(estado)
  }

  /**
   * Abrir un proyecto era lo que mas podia doler: si habia cualquier cosa en
   * localStorage se abria esa, se marcaba el estado como 'local' —que es justo
   * el que dispara el autoguardado 900 ms despues— y la copia local subia
   * encima de la del servidor sin que nadie dijera nada.
   *
   * Ahora hay tres caminos y solo uno de ellos escribe.
   */
  function handleOpenProject(project: RoadmapProject) {
    const delServidor = normalizeDocument(project.document, project)
    const cache = leerCache(project.id)

    if (!cache) {
      abrirCon(project, delServidor, 'synced')
      return
    }

    // Las dos por el mismo rasero antes de compararlas. normalizeDocument
    // rellena el id y el nombre del proyecto a partir de la fila cuando el
    // documento los trae vacios; si solo se le pasara a una de las dos, esa
    // diferencia de relleno se leeria como un conflicto que no existe.
    const documentoLocal = normalizeDocument(cache.document, project)

    // La copia local es un espejo de lo que hay arriba. Es el caso normal
    // —cada guardado deja la cache igual que la respuesta del servidor— y no
    // hay nada pendiente que subir.
    if (mismoDocumento(documentoLocal, delServidor)) {
      escribirCache(project.id, delServidor, project.updated_at)
      abrirCon(project, delServidor, 'synced')
      return
    }

    // Distinta, pero hecha sobre esta misma version: son cambios sin guardar.
    // Se abren y se suben, que es lo que hay que hacer con ellos.
    if (cache.basadoEn === project.updated_at) {
      abrirCon(project, documentoLocal, 'local')
      return
    }

    // Distinta y de otra epoca. Aqui no se puede acertar adivinando.
    setConflicto({ project, documentoLocal, motivo: 'al-abrir' })
  }

  function documentForProject(project: RoadmapProject) {
    const cache = leerCache(project.id)
    return normalizeDocument(cache ? cache.document : project.document, project)
  }

  /** Me quedo con la del servidor: la copia local se va. */
  function resolverConLaDelServidor() {
    if (!conflicto) return
    const { project } = conflicto
    localStorage.removeItem(localStorageKey(project.id))
    setConflicto(null)
    abrirCon(project, normalizeDocument(project.document, project), 'synced')
  }

  /**
   * Me quedo con la mia: se reasienta sobre la version que hay ahora en el
   * servidor, de modo que el guardado siguiente la acepte, y se sube.
   */
  function resolverConLaLocal() {
    if (!conflicto) return
    const { project, documentoLocal } = conflicto
    escribirCache(project.id, documentoLocal, project.updated_at)
    setConflicto(null)
    abrirCon(project, documentoLocal, 'local')
  }

  /** Antes de elegir, llevarse las dos. Nadie tiene que perder nada aqui. */
  function descargarLasDos() {
    if (!conflicto) return
    const { project, documentoLocal } = conflicto
    downloadText(`${project.slug}-copia-local.json`, stringifyRoadmapJson(documentoLocal))
    downloadText(
      `${project.slug}-en-el-servidor.json`,
      stringifyRoadmapJson(normalizeDocument(project.document, project)),
    )
  }

  function handleDocumentChange(nextDocument: RoadmapDocument) {
    if (!activeProject) return

    // La copia local se apunta sobre que version del servidor se esta
    // editando, que es lo que luego permite distinguir trabajo sin guardar
    // de una copia vieja.
    escribirCache(activeProject.id, nextDocument, activeProject.updated_at)
    documentoVivo.current = { id: activeProject.id, document: nextDocument }
    setSyncStatus('local')
    setSyncError('')
    setProjects((currentProjects) =>
      currentProjects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              document: nextDocument,
              name: nextDocument.project.name,
            }
          : project,
      ),
    )
  }

  useEffect(() => {
    if (!activeProject || syncStatus !== 'local') return

    const timeoutId = window.setTimeout(async () => {
      // Si ya hay una escritura de este proyecto en vuelo, no se lanza otra:
      // las dos partirian del mismo sello y la segunda le haria creer a la
      // primera que alguien de fuera ha movido la fila. No se pierde nada por
      // esperar, porque al volver la que esta en vuelo deja el estado en
      // 'local' si quedo algo pendiente, y eso vuelve a programar esta misma
      // espera.
      if (guardando.current) return
      guardando.current = true

      setSyncStatus('syncing')
      const updatedAt = new Date().toISOString()
      // La version sobre la que se ha estado editando. La guarda va en el
      // propio update: si la fila ya no esta asi, no se escribe. Antes esto
      // iba solo con el id, de modo que ganaba el ultimo que llegara y el otro
      // no se enteraba de que acababa de perder su trabajo.
      const versionDePartida = activeProject.updated_at
      // Lo que viaja en esta peticion. Al volver hay que comparar con lo que
      // haya en pantalla entonces, no con esto.
      const documentoEnviado = activeProject.document

      const { data, error } = await supabaseClient
        .from('roadmap_projects')
        .update({
          document: activeProject.document,
          name: activeProject.document.project.name,
          updated_at: updatedAt,
        })
        .eq('id', activeProject.id)
        .eq('updated_at', versionDePartida)
        .select('*')
        .maybeSingle()

      // Lo que hay en pantalla al volver. Si se ha tecleado durante el vuelo,
      // esto ya no es lo que se mando.
      const vivo = documentoVivo.current
      const enPantalla =
        vivo && vivo.id === activeProject.id ? vivo.document : documentoEnviado

      guardando.current = false

      if (error) {
        setSyncError(error.message)
        setSyncStatus('error')
        return
      }

      // Sin error y sin fila: la guarda ha hecho su trabajo. Se trae lo que hay
      // ahora en el servidor y se pregunta, en vez de reintentar por encima.
      if (!data) {
        const { data: actual, error: errorAlReleer } = await supabaseClient
          .from('roadmap_projects')
          .select('*')
          .eq('id', activeProject.id)
          .maybeSingle()

        if (errorAlReleer || !actual) {
          setSyncError(
            'Este proyecto ha cambiado en otro sitio y no se ha podido leer como esta ahora.',
          )
          setSyncStatus('error')
          return
        }

        setSyncStatus('error')
        setSyncError('Este proyecto ha cambiado en otro sitio mientras lo editabas.')
        setConflicto({
          project: actual as RoadmapProject,
          // Lo que se enfrenta a la del servidor es lo que hay en pantalla,
          // con lo tecleado durante el vuelo incluido.
          documentoLocal: enPantalla,
          motivo: 'al-guardar',
        })
        return
      }

      const updatedProject = data as RoadmapProject
      const resuelto = resolverGuardado(documentoEnviado, enPantalla, updatedProject)

      // El sello es siempre el del servidor, y el texto el que corresponda: la
      // cache queda con la version de arriba y con lo que hay escrito, que es
      // justo lo que hace falta para que la escritura siguiente pase la guarda.
      escribirCache(updatedProject.id, resuelto.document, resuelto.updated_at)
      documentoVivo.current = { id: updatedProject.id, document: resuelto.document }
      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === updatedProject.id
            ? {
                ...updatedProject,
                document: resuelto.document,
                name: resuelto.document.project.name,
              }
            : project,
        ),
      )
      // Si se tecleo durante el vuelo, esto queda en 'local' y no en
      // 'synced': el indicador no puede decir "Guardado" con cosas sin subir.
      // Ademas la fila del estado es nueva, asi que este efecto vuelve a
      // correr y programa la espera siguiente, ya con el sello nuevo.
      setSyncStatus(resuelto.estado)
    }, 900)

    return () => window.clearTimeout(timeoutId)
  }, [activeProject, syncStatus])

  async function handleDeleteProject(project: RoadmapProject) {
    // Borrar una fase ya preguntaba; borrar el proyecto entero, no. Y aqui se
    // va mas: la base borra en cascada las claves de lectura del proyecto, sus
    // decisiones y el historial de esas decisiones. No hay papelera ni deshacer.
    const confirmado = window.confirm(
      `Eliminar "${project.name}"?\n\n` +
        'Se va el roadmap entero y, con el, sus claves de lectura, sus ' +
        'decisiones y el historial de esas decisiones. No se puede deshacer.',
    )
    if (!confirmado) return

    setErrorMessage('')
    const projectId = project.id

    const { error } = await supabaseClient
      .from('roadmap_projects')
      .delete()
      .eq('id', projectId)

    if (error) {
      setErrorMessage(error.message)
      return
    }

    localStorage.removeItem(localStorageKey(projectId))
    setProjects((currentProjects) =>
      currentProjects.filter((project) => project.id !== projectId),
    )

    if (activeProjectId === projectId) {
      setActiveProjectId(null)
    }
  }

  /**
   * Se dibuja igual estando en la lista que estando dentro del editor, porque
   * el conflicto puede saltar en los dos sitios: al abrir un proyecto o al
   * guardarlo. No se puede cerrar sin elegir: cerrarlo por las buenas seria
   * volver a decidir por silencio.
   */
  const avisoDeConflicto = conflicto ? (
    <div className="modal-backdrop">
      <section className="modal" aria-labelledby="conflicto-titulo" role="alertdialog">
        <h2 id="conflicto-titulo">Hay dos versiones de "{conflicto.project.name}"</h2>
        <p>
          {conflicto.motivo === 'al-guardar'
            ? 'Mientras editabas, este proyecto ha cambiado en otro sitio. Lo que ' +
              'tienes en pantalla no se ha llegado a guardar.'
            : 'En este navegador hay una copia de este proyecto que no sale de la ' +
              'version que hay ahora en el servidor. Pudo quedarse a medias, o ' +
              'pudiste editarlo en otro sitio despues.'}
        </p>
        <p className="muted">
          La del servidor se guardo el {formatDate(conflicto.project.updated_at)}. Arboria
          no las mezcla ni elige por su cuenta: descargate las dos si quieres mirarlas
          antes, y despues dime con cual sigo.
        </p>
        <div className="modal-actions">
          <button onClick={resolverConLaLocal} type="button">
            Seguir con la mia
          </button>
          <button className="secondary-button" onClick={resolverConLaDelServidor} type="button">
            Abrir la del servidor
          </button>
          <button className="secondary-button" onClick={descargarLasDos} type="button">
            <Icon name="download" /> Descargar las dos
          </button>
        </div>
      </section>
    </div>
  ) : null

  if (activeProject) {
    return (
      <>
        <RoadmapEditor
          availableProjects={projects
            .filter((project) => project.id !== activeProject.id)
            .map((project) => ({ ...project, document: documentForProject(project) }))}
          document={normalizeDocument(activeProject.document, activeProject)}
          projectId={activeProject.id}
          onBack={() => setActiveProjectId(null)}
          onChange={handleDocumentChange}
          onSignOut={() => supabaseClient.auth.signOut()}
          syncError={syncError}
          syncStatus={syncStatus}
        />
        {avisoDeConflicto}
      </>
    )
  }

  return (
    <main className="projects-screen">
      <header className="topbar">
        <div className="brand-row">
          <img src="/arboria-logo.png" alt="" />
          <div>
            <p className="eyebrow">Arboria</p>
            <h1>Roadmaps</h1>
          </div>
        </div>

        <div className="account-actions">
          <span>{session.user.email}</span>
          <button aria-label="Cerrar sesion" className="icon-only" title="Cerrar sesion" type="button" onClick={() => supabaseClient.auth.signOut()}>
            <Icon name="logOut" />
          </button>
        </div>
      </header>

      <section className="workspace-grid">
        <aside className="project-sidebar" aria-label="Proyectos">
          <div className="section-heading">
            <div>
              <h2>Proyectos</h2>
              <p>{projects.length} guardados</p>
            </div>
            <button
              aria-label={isCreating ? 'Creando proyecto' : 'Nuevo proyecto'}
              className="icon-only"
              disabled={isCreating}
              onClick={handleCreateProject}
              title={isCreating ? 'Creando...' : 'Nuevo proyecto'}
              type="button"
            >
              <Icon name="plus" />
            </button>
            <button
              aria-label="Importar proyecto JSON"
              className="icon-only secondary-button"
              onClick={() => setShowProjectImport(true)}
              title="Importar proyecto JSON"
              type="button"
            >
              <Icon name="upload" />
            </button>
          </div>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          {isLoading ? <p className="muted">Cargando proyectos...</p> : null}

          {!isLoading && projects.length === 0 ? (
            <p className="empty-state">
              Todavia no hay proyectos. Crea el primero para preparar el futuro
              editor del arbol.
            </p>
          ) : null}

          <ul className="project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  className={project.id === activeProjectId ? 'active' : ''}
                  onClick={() => handleOpenProject(project)}
                  title="Abrir proyecto"
                  type="button"
                >
                  <strong>{project.name}</strong>
                  <span>{formatDate(project.updated_at)}</span>
                </button>
                <button
                  aria-label={`Descargar JSON de ${project.name}`}
                  className="icon-only secondary-button"
                  onClick={() => handleDownloadProject(project)}
                  title="Descargar JSON"
                  type="button"
                >
                  <Icon name="download" />
                </button>
                <button
                  aria-label={`Eliminar ${project.name}`}
                  className="icon-only text-danger"
                  onClick={() => handleDeleteProject(project)}
                  title="Eliminar"
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      {avisoDeConflicto}

      {showProjectImport ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h2>Importar proyecto JSON</h2>
            <textarea
              aria-label="Importar JSON como proyecto"
              onChange={(event) => setProjectImportText(event.target.value)}
              value={projectImportText}
            />
            <div className="modal-actions">
              <button
                disabled={!projectImportText.trim() || isCreating}
                onClick={handleImportTextAsProject}
                type="button"
              >
                Importar
              </button>
              <button
                className="secondary-button"
                onClick={() => setShowProjectImport(false)}
                type="button"
              >
                Cancelar
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
