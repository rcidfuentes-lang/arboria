import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  RoadmapEditor,
  normalizeRoadmapDocument,
  parseRoadmapJson,
  stringifyRoadmapJson,
} from './RoadmapEditor'
import { Icon } from './Icon'
import { supabase } from '../lib/supabase'
import type { RoadmapDocument, RoadmapProject } from '../types/roadmap'

type ProjectListProps = {
  session: Session
}

const initialDocument: RoadmapDocument = {
  schemaVersion: 1,
  project: {
    id: 'nuevo-proyecto',
    name: 'Nuevo proyecto',
  },
  ideasHtml: '',
  nodes: [
    {
      id: '',
      title: 'Nueva fase',
      status: 'pending',
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
      localStorage.setItem(localStorageKey(createdProject.id), JSON.stringify(createdProject.document))
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

  function handleOpenProject(project: RoadmapProject) {
    const cachedDocument = localStorage.getItem(localStorageKey(project.id))
    const nextDocument = cachedDocument
      ? normalizeRoadmapDocument(JSON.parse(cachedDocument))
      : normalizeDocument(project.document, project)

    setProjects((currentProjects) =>
      currentProjects.map((currentProject) =>
        currentProject.id === project.id
          ? { ...currentProject, document: nextDocument }
          : currentProject,
      ),
    )
    setActiveProjectId(project.id)
    setSyncStatus(cachedDocument ? 'local' : 'synced')
  }

  function documentForProject(project: RoadmapProject) {
    const cachedDocument = localStorage.getItem(localStorageKey(project.id))
    return cachedDocument
      ? normalizeRoadmapDocument(JSON.parse(cachedDocument))
      : normalizeDocument(project.document, project)
  }

  function handleDocumentChange(nextDocument: RoadmapDocument) {
    if (!activeProject) return

    localStorage.setItem(localStorageKey(activeProject.id), JSON.stringify(nextDocument))
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
      setSyncStatus('syncing')
      const updatedAt = new Date().toISOString()
      const { data, error } = await supabaseClient
        .from('roadmap_projects')
        .update({
          document: activeProject.document,
          name: activeProject.document.project.name,
          updated_at: updatedAt,
        })
        .eq('id', activeProject.id)
        .select('*')
        .single()

      if (error) {
        setSyncError(error.message)
        setSyncStatus('error')
        return
      }

      const updatedProject = data as RoadmapProject
      localStorage.setItem(
        localStorageKey(updatedProject.id),
        JSON.stringify(updatedProject.document),
      )
      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === updatedProject.id ? updatedProject : project,
        ),
      )
      setSyncStatus('synced')
    }, 900)

    return () => window.clearTimeout(timeoutId)
  }, [activeProject, syncStatus])

  async function handleDeleteProject(projectId: string) {
    setErrorMessage('')

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

  if (activeProject) {
    return (
      <RoadmapEditor
        availableProjects={projects
          .filter((project) => project.id !== activeProject.id)
          .map((project) => ({ ...project, document: documentForProject(project) }))}
        document={normalizeDocument(activeProject.document, activeProject)}
        onBack={() => setActiveProjectId(null)}
        onChange={handleDocumentChange}
        onSignOut={() => supabaseClient.auth.signOut()}
        syncError={syncError}
        syncStatus={syncStatus}
      />
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
                  onClick={() => handleDeleteProject(project.id)}
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
