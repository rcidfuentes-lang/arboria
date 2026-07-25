import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  RoadmapDocument,
  RoadmapNode,
  RoadmapNodeStatus,
} from '../types/roadmap'

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

type RoadmapEditorProps = {
  document: RoadmapDocument
  syncError: string
  syncStatus: SyncStatus
  onBack: () => void
  onChange: (document: RoadmapDocument) => void
  onSignOut: () => void
}

type FlatNode = {
  node: RoadmapNode
  parentId: string
  index: number
  depth: number
  path: RoadmapNode[]
}

type ImportMode = 'replace-project' | 'append-to-selected' | 'replace-selected'

const statusOptions: Array<{ label: string; value: RoadmapNodeStatus }> = [
  { label: 'Planificada', value: 'planned' },
  { label: 'Pendiente', value: 'pending' },
  { label: 'En curso', value: 'in_progress' },
  { label: 'Bloqueada', value: 'blocked' },
  { label: 'Cerrada', value: 'closed' },
]

const allowedStatuses = new Set(statusOptions.map(({ value }) => value))

function statusLabel(status: RoadmapNodeStatus) {
  return statusOptions.find((option) => option.value === status)?.label ?? status
}

function normalizeStatus(value: unknown): RoadmapNodeStatus {
  if (value === 'done') return 'closed'
  if (allowedStatuses.has(value as RoadmapNodeStatus)) {
    return value as RoadmapNodeStatus
  }
  return 'pending'
}

function statusProgress(status: RoadmapNodeStatus) {
  if (status === 'closed') return 100
  if (status === 'in_progress') return 50
  return 0
}

function nodeProgress(node: RoadmapNode): number {
  if (node.children.length === 0) return statusProgress(node.status)

  const childProgress = node.children.reduce((total, child) => total + nodeProgress(child), 0)
  return Math.round(childProgress / node.children.length)
}

function deriveBranchStatus(node: RoadmapNode): RoadmapNodeStatus {
  if (node.children.length === 0) return node.status

  if (node.children.every((child) => child.status === 'closed')) return 'closed'
  if (node.status === 'closed') return 'in_progress'
  if (
    (node.status === 'planned' || node.status === 'pending') &&
    node.children.some((child) => child.status === 'in_progress' || child.status === 'closed')
  ) {
    return 'in_progress'
  }

  return node.status
}

function applyAutomaticStatuses(nodes: RoadmapNode[]): RoadmapNode[] {
  return nodes.map((node) => {
    const children = applyAutomaticStatuses(node.children)
    const nextNode = { ...node, children }
    return { ...nextNode, status: deriveBranchStatus(nextNode) }
  })
}

function section(title: string, value: unknown) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          return [record.title, record.href].filter(Boolean).join(' | ')
        }
        return ''
      })
      .filter(Boolean)
    return items.length ? `## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}` : ''
  }

  const text = String(value ?? '').trim()
  return text ? `## ${title}\n\n${text}` : ''
}

function legacyContent(value: Record<string, unknown>) {
  const existingContent = String(value.content ?? '').trim()
  const sections = [
    section('Objetivo', value.objective ?? value.goal),
    section('Descripcion', value.description),
    section('Resultado esperado', value.expectedResult ?? value.expectedOutcome),
    section('Dentro de alcance', value.inScope),
    section('Fuera de alcance', value.outOfScope),
    section('Dependencias', value.dependencies),
    section('Documentos', value.documents),
    section('Commits', value.commits),
    section('Notas', value.notes),
  ].filter(Boolean)

  return [existingContent, ...sections].filter(Boolean).join('\n\n')
}

function normalizeNode(value: unknown): RoadmapNode {
  const node = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    id: String(node.id ?? ''),
    title: String(node.title ?? 'Nueva fase'),
    status: normalizeStatus(node.status),
    content: legacyContent(node),
    children: Array.isArray(node.children) ? node.children.map(normalizeNode) : [],
  }
}

export function normalizeRoadmapDocument(value: unknown): RoadmapDocument {
  const document = (value && typeof value === 'object' ? value : {}) as Partial<RoadmapDocument>
  return {
    schemaVersion: 1,
    project: {
      id: String(document.project?.id || 'roadmap'),
      name: String(document.project?.name || 'Roadmap'),
    },
    nodes: Array.isArray(document.nodes) ? applyAutomaticStatuses(document.nodes.map(normalizeNode)) : [],
  }
}

function validateNodes(nodes: unknown[], errors: string[], ids: Set<string>) {
  nodes.forEach((value, index) => {
    if (!value || typeof value !== 'object') {
      errors.push(`Nodo invalido en posicion ${index + 1}.`)
      return
    }

    const node = value as Record<string, unknown>
    const id = String(node.id ?? '')
    if (!id.trim()) errors.push('Hay un nodo con ID vacio.')
    if (id && ids.has(id)) errors.push(`ID duplicado: ${id}.`)
    if (id) ids.add(id)
    if (!Array.isArray(node.children)) errors.push(`children debe ser array en ${id || '(sin ID)'}.`)
    else validateNodes(node.children, errors, ids)
  })
}

export function parseRoadmapJson(value: string): {
  document: RoadmapDocument | null
  errors: string[]
} {
  try {
    const parsed = JSON.parse(value) as Partial<RoadmapDocument>
    const errors: string[] = []
    if (parsed.schemaVersion !== 1) errors.push('schemaVersion debe ser 1.')
    if (!parsed.project || !parsed.project.id || !parsed.project.name) {
      errors.push('project debe incluir id y name.')
    }
    if (!Array.isArray(parsed.nodes)) {
      errors.push('nodes debe ser un array.')
    } else {
      validateNodes(parsed.nodes, errors, new Set())
    }
    return errors.length
      ? { document: null, errors }
      : { document: normalizeRoadmapDocument(parsed), errors: [] }
  } catch (error) {
    return {
      document: null,
      errors: [error instanceof Error ? error.message : 'JSON invalido.'],
    }
  }
}

export function stringifyRoadmapJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function createNode(): RoadmapNode {
  return {
    id: '',
    title: 'Nueva fase',
    status: 'pending',
    content: '',
    children: [],
  }
}

function walk(
  nodes: RoadmapNode[],
  callback: (node: RoadmapNode, parentId: string, index: number, depth: number, path: RoadmapNode[]) => void,
  parentId = '',
  depth = 0,
  path: RoadmapNode[] = [],
) {
  nodes.forEach((node, index) => {
    const nextPath = [...path, node]
    callback(node, parentId, index, depth, nextPath)
    walk(node.children, callback, node.id, depth + 1, nextPath)
  })
}

function flatten(nodes: RoadmapNode[]) {
  const result: FlatNode[] = []
  walk(nodes, (node, parentId, index, depth, path) => {
    result.push({ node, parentId, index, depth, path })
  })
  return result
}

function findNode(nodes: RoadmapNode[], id: string): RoadmapNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

function contains(node: RoadmapNode, id: string): boolean {
  return node.id === id || node.children.some((child) => contains(child, id))
}

function updateNode(nodes: RoadmapNode[], id: string, updater: (node: RoadmapNode) => RoadmapNode): RoadmapNode[] {
  return nodes.map((node) =>
    node.id === id
      ? updater(node)
      : { ...node, children: updateNode(node.children, id, updater) },
  )
}

function insertNode(nodes: RoadmapNode[], parentId: string, node: RoadmapNode, index?: number): RoadmapNode[] {
  if (!parentId) {
    const next = [...nodes]
    next.splice(index ?? next.length, 0, node)
    return next
  }
  return updateNode(nodes, parentId, (parent) => {
    const children = [...parent.children]
    children.splice(index ?? children.length, 0, node)
    return { ...parent, children }
  })
}

function removeNode(nodes: RoadmapNode[], id: string): RoadmapNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children, id) }))
}

function cloneBranch(node: RoadmapNode): RoadmapNode {
  const suffix = Date.now().toString(36)
  const clone = (item: RoadmapNode): RoadmapNode => ({
    ...item,
    id: item.id ? `${item.id}-copia-${suffix}` : '',
    title: `${item.title} copia`,
    children: item.children.map(clone),
  })
  return clone(node)
}

function branchIds(node: RoadmapNode): string[] {
  return [node.id, ...node.children.flatMap(branchIds)]
}

function collectNodeIds(nodes: RoadmapNode[], ignoredIds = new Set<string>()) {
  const ids = new Set<string>()
  walk(nodes, (node) => {
    if (node.id && !ignoredIds.has(node.id)) ids.add(node.id)
  })
  return ids
}

function duplicateNodeIds(nodes: RoadmapNode[], existingIds: Set<string>) {
  const duplicates = new Set<string>()
  walk(nodes, (node) => {
    if (node.id && existingIds.has(node.id)) duplicates.add(node.id)
  })
  return [...duplicates]
}

function replaceNodeWithNodes(nodes: RoadmapNode[], id: string, replacements: RoadmapNode[]): RoadmapNode[] {
  return nodes.flatMap((node) => {
    if (node.id === id) return replacements
    return { ...node, children: replaceNodeWithNodes(node.children, id, replacements) }
  })
}

function setBranchStatus(node: RoadmapNode, status: RoadmapNodeStatus): RoadmapNode {
  return {
    ...node,
    status,
    children: node.children.map((child) => setBranchStatus(child, status)),
  }
}

function nodeMarkdown(node: RoadmapNode, depth = 1, includeChildren = false): string {
  const lines = [
    `${'#'.repeat(Math.min(depth, 6))} ${node.id} — ${node.title}`,
    '',
    `**Estado:** ${statusLabel(node.status)}`,
    `**Progreso:** ${nodeProgress(node)}%`,
  ]
  if (node.content.trim()) lines.push('', node.content.trim())
  if (includeChildren) {
    node.children.forEach((child) => lines.push('', nodeMarkdown(child, depth + 1, true)))
  }
  return lines.join('\n')
}

function nodeJson(node: RoadmapNode): string {
  return stringifyRoadmapJson({
    id: node.id,
    title: node.title,
    status: node.status,
    content: node.content,
  })
}

function markdownToHtml(markdown: string) {
  return markdown
    .split('\n')
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) return `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`
      if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`
      if (!line.trim()) return ''
      return `<p>${line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</p>`
    })
    .join('\n')
}

function syncLabel(syncStatus: SyncStatus) {
  if (syncStatus === 'local') return 'Guardado localmente'
  if (syncStatus === 'syncing') return 'Sincronizando'
  if (syncStatus === 'synced') return 'Sincronizado'
  return 'Error'
}

function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = window.document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

export function RoadmapEditor({
  document,
  onBack,
  onChange,
  onSignOut,
  syncError,
  syncStatus,
}: RoadmapEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>('replace-project')
  const [importText, setImportText] = useState('')
  const [showPrint, setShowPrint] = useState(false)
  const [printScope, setPrintScope] = useState<'selected' | 'branch' | 'all'>('all')
  const [errorMessage, setErrorMessage] = useState('')
  const [focusIdNonce, setFocusIdNonce] = useState(0)
  const idInputRef = useRef<HTMLInputElement>(null)
  const nodeRefs = useRef<Record<string, HTMLLIElement | null>>({})

  const flatNodes = useMemo(() => flatten(document.nodes), [document.nodes])
  const selectedNode = selectedId === null ? null : findNode(document.nodes, selectedId)
  const selectedFlatNode = useMemo(
    () => flatNodes.find(({ node }) => node.id === selectedId) ?? null,
    [flatNodes, selectedId],
  )
  const projectProgress = useMemo(() => {
    if (document.nodes.length === 0) return 0
    const totalProgress = document.nodes.reduce((total, node) => total + nodeProgress(node), 0)
    return Math.round(totalProgress / document.nodes.length)
  }, [document.nodes])

  useEffect(() => {
    if (!selectedNode && flatNodes[0]) setSelectedId(flatNodes[0].node.id)
  }, [flatNodes, selectedNode])

  useEffect(() => {
    if (focusIdNonce > 0) idInputRef.current?.focus()
  }, [focusIdNonce])

  function emitNodes(nodes: RoadmapNode[]) {
    onChange({ ...document, nodes: applyAutomaticStatuses(nodes) })
  }

  function selectNode(node: RoadmapNode) {
    setSelectedId(node.id)
    setOpenMenuId(null)
  }

  function addNode(parentId: string, index?: number) {
    const node = createNode()
    emitNodes(insertNode(document.nodes, parentId, node, index))
    setSelectedId(node.id)
    if (parentId) setExpandedIds((current) => new Set([...current, parentId]))
    setFocusIdNonce((value) => value + 1)
  }

  function duplicateNode(node: RoadmapNode, parentId: string, index: number) {
    const clone = cloneBranch(node)
    emitNodes(insertNode(document.nodes, parentId, clone, index + 1))
    setSelectedId(clone.id)
    setFocusIdNonce((value) => value + 1)
  }

  function moveNode(node: RoadmapNode, parentId: string, index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    const siblings = parentId ? findNode(document.nodes, parentId)?.children ?? [] : document.nodes
    if (nextIndex < 0 || nextIndex >= siblings.length) return
    emitNodes(insertNode(removeNode(document.nodes, node.id), parentId, node, nextIndex))
  }

  function changeParent(node: RoadmapNode, parentId: string) {
    if (parentId === node.id || contains(node, parentId)) return
    emitNodes(insertNode(removeNode(document.nodes, node.id), parentId, node))
    if (parentId) setExpandedIds((current) => new Set([...current, parentId]))
  }

  function updateSelected<K extends keyof RoadmapNode>(key: K, value: RoadmapNode[K]) {
    if (!selectedNode) return
    const previousId = selectedNode.id
    emitNodes(updateNode(document.nodes, previousId, (node) => ({ ...node, [key]: value })))
    if (key === 'id') setSelectedId(String(value))
  }

  function deleteNode(node: RoadmapNode) {
    if (!window.confirm(`Eliminar "${node.title}" y sus descendientes?`)) return
    emitNodes(removeNode(document.nodes, node.id))
    if (selectedId !== null && (selectedId === node.id || branchIds(node).includes(selectedId))) {
      setSelectedId(null)
    }
  }

  function closeNode(node: RoadmapNode) {
    emitNodes(updateNode(document.nodes, node.id, (current) => setBranchStatus(current, 'closed')))
    setOpenMenuId(null)
  }

  async function copySelectedJson() {
    if (!selectedNode) return
    const nextNode = { ...selectedNode, status: 'in_progress' as RoadmapNodeStatus }
    emitNodes(updateNode(document.nodes, selectedNode.id, () => nextNode))
    await copyText(nodeJson(nextNode))
  }

  function exportProject() {
    downloadText(`${document.project.id || 'roadmap'}.json`, stringifyRoadmapJson(document))
  }

  function exportBranch() {
    if (!selectedNode) return
    downloadText(`${selectedNode.id || 'rama'}.json`, stringifyRoadmapJson({ ...document, nodes: [selectedNode] }))
  }

  function openImport(mode: ImportMode) {
    setImportMode(mode)
    setShowImport(true)
    setErrorMessage('')
  }

  function closeImport() {
    setShowImport(false)
    setImportText('')
    setErrorMessage('')
  }

  function importJson() {
    const result = parseRoadmapJson(importText)
    if (!result.document) {
      setErrorMessage(result.errors.join(' '))
      return
    }

    const importedNodes = applyAutomaticStatuses(result.document.nodes)
    if (importedNodes.length === 0) {
      setErrorMessage('El JSON no contiene ninguna fase.')
      return
    }

    if (importMode === 'replace-project') {
      onChange({ ...result.document, nodes: importedNodes })
      setSelectedId(importedNodes[0]?.id ?? '')
      setShowImport(false)
      setImportText('')
      setErrorMessage('')
      return
    }

    if (!selectedNode) {
      setErrorMessage('Selecciona una fase antes de importar una rama.')
      return
    }

    const ignoredIds = importMode === 'replace-selected' ? new Set(branchIds(selectedNode)) : new Set<string>()
    const duplicates = duplicateNodeIds(importedNodes, collectNodeIds(document.nodes, ignoredIds))
    if (duplicates.length > 0) {
      setErrorMessage(`El JSON contiene IDs que ya existen en este roadmap: ${duplicates.join(', ')}.`)
      return
    }

    if (importMode === 'append-to-selected') {
      emitNodes(updateNode(document.nodes, selectedNode.id, (node) => ({
        ...node,
        children: [...node.children, ...importedNodes],
      })))
      setExpandedIds((current) => new Set([...current, selectedNode.id]))
      setSelectedId(importedNodes[0]?.id ?? selectedNode.id)
    } else {
      emitNodes(replaceNodeWithNodes(document.nodes, selectedNode.id, importedNodes))
      setSelectedId(importedNodes[0]?.id ?? null)
    }

    setShowImport(false)
    setImportText('')
    setErrorMessage('')
  }

  function printRoadmap(scope: 'selected' | 'branch' | 'all') {
    setPrintScope(scope)
    setShowPrint(false)
    window.setTimeout(() => window.print(), 50)
  }

  const visibleIds = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return new Set(flatNodes.map(({ node }) => node.id))
    const matches = flatNodes.filter(({ node }) =>
      [node.id, node.title, node.content].join(' ').toLowerCase().includes(text),
    )
    const ids = new Set<string>()
    matches.forEach(({ path }) => path.forEach((node) => ids.add(node.id)))
    return ids
  }, [flatNodes, query])

  useEffect(() => {
    const text = query.trim().toLowerCase()
    if (!text) return
    const match = flatNodes.find(({ node }) =>
      [node.id, node.title, node.content].join(' ').toLowerCase().includes(text),
    )
    if (!match) return
    setSelectedId(match.node.id)
    setExpandedIds((current) => {
      const next = new Set(current)
      match.path.slice(0, -1).forEach((node) => next.add(node.id))
      return next
    })
    window.setTimeout(() => nodeRefs.current[match.node.id]?.scrollIntoView({ block: 'nearest' }), 30)
  }, [flatNodes, query])

  const printNodes =
    printScope === 'selected'
      ? selectedNode
        ? [selectedNode]
        : []
      : printScope === 'branch'
        ? selectedNode
          ? [selectedNode]
          : []
        : document.nodes
  const printMarkdown = printNodes.map((node) => nodeMarkdown(node, 1, printScope !== 'selected')).join('\n\n')

  function renderNode(node: RoadmapNode, depth = 0, parentId = '', index = 0) {
    if (!visibleIds.has(node.id)) return null
    const expanded = expandedIds.has(node.id)
    const parentOptions = flatNodes.filter((item) => item.node.id !== node.id && !contains(node, item.node.id))
    const progress = nodeProgress(node)

    return (
      <li
        className="file-tree-item"
        key={`${parentId}-${index}-${node.id}`}
        ref={(element) => {
          if (node.id) nodeRefs.current[node.id] = element
        }}
      >
        <div className={`file-row ${selectedId === node.id ? 'selected' : ''}`} style={{ '--depth': depth } as CSSProperties}>
          <span className="tree-line" aria-hidden="true" />
          <button className="tree-toggle" disabled={node.children.length === 0} onClick={() => {
            setExpandedIds((current) => {
              const next = new Set(current)
              if (next.has(node.id)) next.delete(node.id)
              else next.add(node.id)
              return next
            })
          }} type="button">
            {node.children.length === 0 ? '' : expanded ? '−' : '+'}
          </button>
          <button className="file-name" onClick={() => selectNode(node)} type="button">
            <span className={`state-dot ${node.status}`} />
            <strong>{node.id || 'sin-id'}</strong>
            <span>{node.title || 'Nueva fase'}</span>
          </button>
          <span className="progress-chip" title={`${progress}% completado`}>{progress}%</span>
          <button
            aria-label={`Cerrar ${node.title || node.id || 'fase'}`}
            className="quick-close-button"
            disabled={node.status === 'closed'}
            onClick={() => closeNode(node)}
            title="Cerrar"
            type="button"
          >
            Cerrar
          </button>
          <button className="copy-button" onClick={() => copyText(nodeMarkdown(node))} type="button">Copiar</button>
          <button className="menu-button" onClick={() => setOpenMenuId(openMenuId === node.id ? null : node.id)} type="button">···</button>
        </div>
        {openMenuId === node.id ? (
          <div className="node-menu">
            <button onClick={() => addNode(node.id)} type="button">Añadir hijo</button>
            <button onClick={() => addNode(parentId, index + 1)} type="button">Añadir hermano</button>
            <button onClick={() => duplicateNode(node, parentId, index)} type="button">Duplicar rama</button>
            <button onClick={() => moveNode(node, parentId, index, -1)} type="button">Mover arriba</button>
            <button onClick={() => moveNode(node, parentId, index, 1)} type="button">Mover abajo</button>
            <label>
              Cambiar padre
              <select onChange={(event) => changeParent(node, event.target.value)} value={parentId}>
                <option value="">Raíz</option>
                {parentOptions.map(({ node: optionNode }) => (
                  <option key={optionNode.id} value={optionNode.id}>{optionNode.id} — {optionNode.title}</option>
                ))}
              </select>
            </label>
            <button onClick={() => copyText(nodeMarkdown(node))} type="button">Copiar fase</button>
            <button onClick={() => copyText(nodeMarkdown(node, 1, true))} type="button">Copiar rama</button>
            <button className="text-danger" onClick={() => deleteNode(node)} type="button">Eliminar</button>
          </div>
        ) : null}
        {expanded && node.children.length > 0 ? (
          <ul className="file-tree-list">
            {node.children.map((child, childIndex) => renderNode(child, depth + 1, node.id, childIndex))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <main className="roadmap-screen">
      <header className="roadmap-bar no-print">
        <div className="roadmap-title">
          <img src="/arboria-logo.png" alt="" />
          <input
            aria-label="Nombre del proyecto"
            onChange={(event) => onChange({ ...document, project: { ...document.project, name: event.target.value } })}
            value={document.project.name}
          />
        </div>
        <span className="project-progress" title={`${projectProgress}% completado`}>
          <span style={{ width: `${projectProgress}%` }} />
          <strong>{projectProgress}%</strong>
        </span>
        <span className={`sync-state ${syncStatus}`}>{syncLabel(syncStatus)}{syncError ? ` · ${syncError}` : ''}</span>
        <input aria-label="Buscar" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" type="search" value={query} />
        <div className="toolbar-group">
          <button onClick={() => openImport('replace-project')} type="button">Importar</button>
          <button className="secondary-button" onClick={exportProject} type="button">Exportar</button>
          <button className="secondary-button" onClick={exportBranch} type="button">Rama</button>
          <button className="secondary-button" onClick={() => setShowPrint(true)} type="button">Imprimir</button>
        </div>
        <div className="toolbar-group">
          <button className="secondary-button" onClick={onBack} type="button">Proyectos</button>
          <button className="secondary-button" onClick={onSignOut} type="button">Salir</button>
        </div>
      </header>

      {errorMessage ? <p className="form-error no-print">{errorMessage}</p> : null}

      <section className="roadmap-body">
        <aside className="file-tree no-print">
          <div className="tree-mini-actions">
            <button onClick={() => addNode('')} type="button">Añadir raíz</button>
            <button onClick={() => setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))} type="button">Expandir todo</button>
            <button onClick={() => setExpandedIds(new Set())} type="button">Contraer todo</button>
          </div>
          <ul className="file-tree-list root">
            {document.nodes.map((node, index) => renderNode(node, 0, '', index))}
          </ul>
        </aside>

        <section className="text-editor">
          {selectedNode ? (
            <>
              <div className="selected-progress no-print">
                <div>
                  <span>Progreso</span>
                  <strong>{nodeProgress(selectedNode)}%</strong>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <span style={{ width: `${nodeProgress(selectedNode)}%` }} />
                </div>
              </div>
              <div className="editor-actions no-print">
                <button onClick={() => addNode(selectedNode.id)} type="button">Añadir subfase</button>
                <button
                  className="secondary-button"
                  onClick={() => addNode(selectedFlatNode?.parentId ?? '', (selectedFlatNode?.index ?? 0) + 1)}
                  type="button"
                >
                  Añadir hermana
                </button>
                <button className="secondary-button" onClick={() => openImport('append-to-selected')} type="button">Importar como subfases</button>
                <button className="secondary-button" onClick={() => openImport('replace-selected')} type="button">Reemplazar esta rama</button>
                <button className="secondary-button" onClick={copySelectedJson} type="button">Copiar JSON</button>
              </div>
              <div className="editor-fields no-print">
                <label>ID<input ref={idInputRef} onChange={(event) => updateSelected('id', event.target.value)} value={selectedNode.id} /></label>
                <label>Título<input onChange={(event) => updateSelected('title', event.target.value)} value={selectedNode.title} /></label>
                <label>Estado<select onChange={(event) => updateSelected('status', event.target.value as RoadmapNodeStatus)} value={selectedNode.status}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <textarea
                aria-label="Contenido"
                className="content-editor"
                onChange={(event) => updateSelected('content', event.target.value)}
                placeholder="Markdown de la fase"
                value={selectedNode.content}
              />
            </>
          ) : (
            <p className="empty-state">Selecciona o crea una fase.</p>
          )}
        </section>
      </section>

      {showImport ? (
        <div className="modal-backdrop no-print">
          <section className="modal">
            <h2>Importar JSON</h2>
            <div className="import-modes" role="group" aria-label="Modo de importación">
              <label>
                <input
                  checked={importMode === 'append-to-selected'}
                  disabled={!selectedNode}
                  name="import-mode"
                  onChange={() => setImportMode('append-to-selected')}
                  type="radio"
                />
                Añadir como subfases
              </label>
              <label>
                <input
                  checked={importMode === 'replace-selected'}
                  disabled={!selectedNode}
                  name="import-mode"
                  onChange={() => setImportMode('replace-selected')}
                  type="radio"
                />
                Reemplazar rama seleccionada
              </label>
              <label>
                <input
                  checked={importMode === 'replace-project'}
                  name="import-mode"
                  onChange={() => setImportMode('replace-project')}
                  type="radio"
                />
                Reemplazar proyecto completo
              </label>
            </div>
            {importMode !== 'replace-project' && selectedNode ? (
              <p className="modal-hint">Destino: {selectedNode.id || 'sin-id'} — {selectedNode.title || 'Nueva fase'}</p>
            ) : null}
            <textarea aria-label="Pegar JSON" onChange={(event) => setImportText(event.target.value)} value={importText} />
            <div className="modal-actions">
              <button onClick={importJson} type="button">Importar</button>
              <button className="secondary-button" onClick={closeImport} type="button">Cancelar</button>
            </div>
          </section>
        </div>
      ) : null}

      {showPrint ? (
        <div className="modal-backdrop no-print">
          <section className="modal compact">
            <h2>Imprimir</h2>
            <button onClick={() => printRoadmap('selected')} type="button">Fase seleccionada</button>
            <button onClick={() => printRoadmap('branch')} type="button">Rama seleccionada</button>
            <button onClick={() => printRoadmap('all')} type="button">Roadmap completo</button>
            <button className="secondary-button" onClick={() => setShowPrint(false)} type="button">Cancelar</button>
          </section>
        </div>
      ) : null}

      <section className="print-surface" dangerouslySetInnerHTML={{ __html: markdownToHtml(printMarkdown) }} />
    </main>
  )
}
