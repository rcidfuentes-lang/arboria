import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  RoadmapEditor,
  normalizeRoadmapDocument,
  parseRoadmapJson,
  stringifyRoadmapJson,
} from './RoadmapEditor'
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
  nodes: [
    {
      id: 'vision',
      title: 'Vision del proyecto',
      status: 'pending',
      objective: 'Definir la direccion principal del roadmap.',
      description: '',
      expectedResult: 'Un objetivo claro para guiar el arbol.',
      inScope: [],
      outOfScope: [],
      dependencies: [],
      documents: [],
      commits: [],
      notes: '',
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

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  )

  async function loadProjects() {
    setErrorMessage('')
    setIsLoading(true)

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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
      ? (JSON.parse(cachedDocument) as RoadmapDocument)
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
      const { data, error } = await supabase
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

    const { error } = await supabase
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

  return (
    <main className="workspace-shell">
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
          <button type="button" onClick={() => supabase.auth.signOut()}>
            Cerrar sesion
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
              disabled={isCreating}
              onClick={handleCreateProject}
              type="button"
            >
              {isCreating ? 'Creando...' : 'Nuevo'}
            </button>
          </div>

          <div className="project-import">
            <textarea
              aria-label="Importar JSON como proyecto"
              onChange={(event) => setProjectImportText(event.target.value)}
              placeholder="Importar JSON como proyecto"
              value={projectImportText}
            />
            <button
              disabled={!projectImportText.trim() || isCreating}
              onClick={handleImportTextAsProject}
              type="button"
            >
              Importar JSON
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
                  type="button"
                >
                  <strong>{project.name}</strong>
                  <span>{formatDate(project.updated_at)}</span>
                </button>
                <button
                  aria-label={`Eliminar ${project.name}`}
                  className="text-danger"
                  onClick={() => handleDeleteProject(project.id)}
                  type="button"
                >
                  Eliminar
                </button>
                <button
                  className="secondary-button"
                  onClick={() => handleDownloadProject(project)}
                  type="button"
                >
                  Descargar JSON
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="editor-placeholder" aria-live="polite">
          {activeProject ? (
            <RoadmapEditor
              document={normalizeDocument(activeProject.document, activeProject)}
              onImportAsProject={handleImportProject}
              onChange={handleDocumentChange}
              syncError={syncError}
              syncStatus={syncStatus}
            />
          ) : (
            <>
              <p className="eyebrow">Editor pendiente</p>
              <h2>Abre o crea un proyecto</h2>
              <p>
                La siguiente fase podra montar aqui el arbol completo sin tocar
                la base de autenticacion y proyectos.
              </p>
            </>
          )}
        </section>
      </section>
    </main>
  )
}
