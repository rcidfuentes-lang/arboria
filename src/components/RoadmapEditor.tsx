import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, FormEvent, MouseEvent } from 'react'
import type {
  RoadmapDocument,
  RoadmapIdea,
  RoadmapNode,
  RoadmapNodeStatus,
  RoadmapProject,
} from '../types/roadmap'
import { Icon } from './Icon'

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

type RoadmapEditorProps = {
  availableProjects: RoadmapProject[]
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
type EditorMode = 'editor' | 'canvas' | 'ideas'
type ProjectMergeMode = 'append-root' | 'append-to-selected'
type DropTarget =
  | { type: 'root' }
  | { type: 'child'; parentId: string }
  | { type: 'sibling'; parentId: string; index: number }

type CanvasNode = FlatNode & {
  x: number
  y: number
}

type FormatAction = {
  command: string
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  value?: string
}

const canvasNodeWidth = 380
const canvasNodeHeight = 126
const canvasColumnGap = 470
const canvasRowGap = 158

const statusOptions: Array<{ label: string; value: RoadmapNodeStatus }> = [
  { label: 'Planificada', value: 'planned' },
  { label: 'Pendiente', value: 'pending' },
  { label: 'En curso', value: 'in_progress' },
  { label: 'Bloqueada', value: 'blocked' },
  { label: 'Cerrada', value: 'closed' },
]

const allowedStatuses = new Set(statusOptions.map(({ value }) => value))

const richTextActions: FormatAction[] = [
  { command: 'bold', icon: 'bold', label: 'Negrita' },
  { command: 'italic', icon: 'italic', label: 'Cursiva' },
  { command: 'underline', icon: 'underline', label: 'Subrayado' },
  { command: 'strikeThrough', icon: 'strikethrough', label: 'Tachado' },
  { command: 'formatBlock', icon: 'quote', label: 'Cita', value: 'blockquote' },
  { command: 'insertUnorderedList', icon: 'list', label: 'Lista' },
  { command: 'insertOrderedList', icon: 'listOrdered', label: 'Lista numerada' },
  { command: 'removeFormat', icon: 'eraser', label: 'Limpiar formato' },
]

const allowedRichTextTags = new Set([
  'B',
  'BLOCKQUOTE',
  'BR',
  'DIV',
  'EM',
  'H2',
  'H3',
  'I',
  'LI',
  'OL',
  'P',
  'S',
  'STRIKE',
  'STRONG',
  'U',
  'UL',
])

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

function sanitizeRichText(html: string) {
  if (!html.trim()) return ''
  const parsed = new window.DOMParser().parseFromString(html, 'text/html')
  parsed.body.querySelectorAll('*').forEach((element) => {
    if (!allowedRichTextTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      return
    }
    Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name))
  })
  return parsed.body.innerHTML.trim()
}

function htmlToPlainText(html: string) {
  if (!html.trim()) return ''
  const parsed = new window.DOMParser().parseFromString(html, 'text/html')
  return parsed.body.textContent?.trim() ?? ''
}

function normalizeIdea(value: unknown): RoadmapIdea {
  const idea = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const now = new Date().toISOString()
  return {
    id: String(idea.id || `idea-${Date.now().toString(36)}`),
    title: String(idea.title || 'Idea sin titulo'),
    bodyHtml: sanitizeRichText(String(idea.bodyHtml ?? '')),
    created_at: String(idea.created_at || now),
    updated_at: String(idea.updated_at || now),
  }
}

function ideasFromLegacyHtml(value: unknown): RoadmapIdea[] {
  const bodyHtml = sanitizeRichText(String(value ?? ''))
  if (!htmlToPlainText(bodyHtml)) return []
  const now = new Date().toISOString()
  return [{
    id: `idea-${Date.now().toString(36)}`,
    title: 'Ideas generales',
    bodyHtml,
    created_at: now,
    updated_at: now,
  }]
}

export function normalizeRoadmapDocument(value: unknown): RoadmapDocument {
  const document = (value && typeof value === 'object' ? value : {}) as Partial<RoadmapDocument>
  const legacyDocument = document as Partial<RoadmapDocument> & { ideasHtml?: unknown }
  return {
    schemaVersion: 1,
    project: {
      id: String(document.project?.id || 'roadmap'),
      name: String(document.project?.name || 'Roadmap'),
    },
    ideas: Array.isArray(document.ideas)
      ? document.ideas.map(normalizeIdea)
      : ideasFromLegacyHtml(legacyDocument.ideasHtml),
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
  const id = `fase-${Date.now().toString(36)}`
  return {
    id,
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

function layoutCanvasNodes(nodes: FlatNode[]) {
  return nodes.map((item, order): CanvasNode => ({
    ...item,
    x: item.depth * canvasColumnGap,
    y: order * canvasRowGap,
  }))
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

function countDescendants(node: RoadmapNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0)
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

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(index, length))
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

function cloneNodesWithUniqueIds(nodes: RoadmapNode[], existingIds: Set<string>, prefix: string) {
  const suffix = Date.now().toString(36)
  const normalizePart = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const nextId = (id: string, fallback: string) => {
    const base = normalizePart(id || fallback) || 'fase'
    let candidate = base
    if (existingIds.has(candidate)) candidate = `${normalizePart(prefix) || 'proyecto'}-${base}`
    if (existingIds.has(candidate)) candidate = `${candidate}-${suffix}`
    let index = 2
    while (existingIds.has(candidate)) {
      candidate = `${normalizePart(prefix) || 'proyecto'}-${base}-${suffix}-${index}`
      index += 1
    }
    existingIds.add(candidate)
    return candidate
  }

  const clone = (node: RoadmapNode, index: number): RoadmapNode => ({
    ...node,
    id: nextId(node.id, `fase-${index + 1}`),
    children: node.children.map(clone),
  })

  return nodes.map(clone)
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
  availableProjects,
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
  const [showProjectMerge, setShowProjectMerge] = useState(false)
  const [mergeProjectId, setMergeProjectId] = useState('')
  const [projectMergeMode, setProjectMergeMode] = useState<ProjectMergeMode>('append-root')
  const [errorMessage, setErrorMessage] = useState('')
  const [focusIdNonce, setFocusIdNonce] = useState(0)
  const [editorMode, setEditorMode] = useState<EditorMode>('editor')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null)
  const idInputRef = useRef<HTMLInputElement>(null)
  const ideaEditorRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Record<string, HTMLLIElement | null>>({})

  const flatNodes = useMemo(() => flatten(document.nodes), [document.nodes])
  const selectedNode = selectedId === null ? null : findNode(document.nodes, selectedId)
  const selectedFlatNode = useMemo(
    () => flatNodes.find(({ node }) => node.id === selectedId) ?? null,
    [flatNodes, selectedId],
  )
  const selectedIdea = selectedIdeaId === null
    ? document.ideas[0] ?? null
    : document.ideas.find((idea) => idea.id === selectedIdeaId) ?? document.ideas[0] ?? null
  const projectProgress = useMemo(() => {
    if (document.nodes.length === 0) return 0
    const totalProgress = document.nodes.reduce((total, node) => total + nodeProgress(node), 0)
    return Math.round(totalProgress / document.nodes.length)
  }, [document.nodes])
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
  const filteredIdeas = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return document.ideas
    return document.ideas.filter((idea) =>
      [idea.title, htmlToPlainText(idea.bodyHtml)].join(' ').toLowerCase().includes(text),
    )
  }, [document.ideas, query])
  const navigationNodes = useMemo(() => {
    const isSearching = query.trim().length > 0
    return flatNodes.filter(({ node, path }) => {
      if (!visibleIds.has(node.id)) return false
      if (isSearching) return true
      return path.slice(0, -1).every((ancestor) => expandedIds.has(ancestor.id))
    })
  }, [expandedIds, flatNodes, query, visibleIds])
  const canvasNodes = useMemo(() => layoutCanvasNodes(navigationNodes), [navigationNodes])
  const canvasLookup = useMemo(
    () => new Map(canvasNodes.map((item) => [item.node.id, item])),
    [canvasNodes],
  )
  const canvasWidth = Math.max(
    720,
    (Math.max(0, ...canvasNodes.map((item) => item.depth)) + 1) * canvasColumnGap,
  )
  const canvasHeight = Math.max(440, canvasNodes.length * canvasRowGap + 60)

  useEffect(() => {
    if (!selectedNode && flatNodes[0]) setSelectedId(flatNodes[0].node.id)
  }, [flatNodes, selectedNode])

  useEffect(() => {
    if (focusIdNonce > 0) idInputRef.current?.focus()
  }, [focusIdNonce])

  useEffect(() => {
    if (selectedIdeaId && document.ideas.some((idea) => idea.id === selectedIdeaId)) return
    setSelectedIdeaId(document.ideas[0]?.id ?? null)
  }, [document.ideas, selectedIdeaId])

  useEffect(() => {
    const editor = ideaEditorRef.current
    if (!editor || window.document.activeElement === editor) return
    const nextHtml = selectedIdea?.bodyHtml ?? ''
    if (editor.innerHTML !== nextHtml) editor.innerHTML = nextHtml
  }, [selectedIdea])

  function emitNodes(nodes: RoadmapNode[]) {
    onChange({ ...document, nodes: applyAutomaticStatuses(nodes) })
  }

  function updateIdeas(ideas: RoadmapIdea[]) {
    onChange({ ...document, ideas })
  }

  function createIdea() {
    const now = new Date().toISOString()
    const idea: RoadmapIdea = {
      id: `idea-${Date.now().toString(36)}`,
      title: 'Nueva idea',
      bodyHtml: '',
      created_at: now,
      updated_at: now,
    }
    updateIdeas([idea, ...document.ideas])
    setSelectedIdeaId(idea.id)
    window.setTimeout(() => ideaEditorRef.current?.focus(), 30)
  }

  function updateIdea(id: string, updater: (idea: RoadmapIdea) => RoadmapIdea) {
    updateIdeas(document.ideas.map((idea) => (
      idea.id === id ? { ...updater(idea), updated_at: new Date().toISOString() } : idea
    )))
  }

  function updateSelectedIdeaBody(html: string) {
    if (!selectedIdea) return
    updateIdea(selectedIdea.id, (idea) => ({ ...idea, bodyHtml: sanitizeRichText(html) }))
  }

  function deleteIdea(idea: RoadmapIdea) {
    if (!window.confirm(`Eliminar "${idea.title}"?`)) return
    const nextIdeas = document.ideas.filter((item) => item.id !== idea.id)
    updateIdeas(nextIdeas)
    setSelectedIdeaId(nextIdeas[0]?.id ?? null)
  }

  function handleIdeaInput(event: FormEvent<HTMLDivElement>) {
    updateSelectedIdeaBody(event.currentTarget.innerHTML)
  }

  function formatIdea(event: MouseEvent<HTMLButtonElement>, action: FormatAction) {
    event.preventDefault()
    ideaEditorRef.current?.focus()
    window.document.execCommand(action.command, false, action.value)
    updateSelectedIdeaBody(ideaEditorRef.current?.innerHTML ?? '')
  }

  function selectNode(node: RoadmapNode) {
    setSelectedId(node.id)
    setOpenMenuId(null)
  }

  function toggleNodeExpansion(node: RoadmapNode) {
    if (node.children.length === 0) return
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(node.id)) next.delete(node.id)
      else next.add(node.id)
      return next
    })
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

  function moveBranch(nodeId: string, target: DropTarget) {
    const node = findNode(document.nodes, nodeId)
    const source = flatNodes.find((item) => item.node.id === nodeId)
    if (!node || !source) return

    if (target.type === 'root') {
      emitNodes(insertNode(removeNode(document.nodes, node.id), '', node))
      setSelectedId(node.id)
      return
    }

    if (target.type === 'child') {
      if (target.parentId === node.id || contains(node, target.parentId)) return
      emitNodes(insertNode(removeNode(document.nodes, node.id), target.parentId, node))
      setExpandedIds((current) => new Set([...current, target.parentId]))
      setSelectedId(node.id)
      return
    }

    if (target.parentId === node.id) return
    const targetParent = target.parentId ? findNode(document.nodes, target.parentId) : null
    const targetSiblings = target.parentId ? targetParent?.children ?? [] : document.nodes
    const sameParent = source.parentId === target.parentId
    const adjustedIndex = sameParent && source.index < target.index ? target.index - 1 : target.index
    emitNodes(insertNode(removeNode(document.nodes, node.id), target.parentId, node, clampIndex(adjustedIndex, targetSiblings.length)))
    setSelectedId(node.id)
  }

  function canDropOn(target: DropTarget, nodeId = draggedId) {
    if (!nodeId) return false
    const node = findNode(document.nodes, nodeId)
    if (!node) return false
    if (target.type === 'child') return target.parentId !== node.id && !contains(node, target.parentId)
    if (target.type === 'sibling') return target.parentId !== node.id
    return true
  }

  function handleDragStart(event: DragEvent, node: RoadmapNode) {
    setDraggedId(node.id)
    setOpenMenuId(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.id)
  }

  function handleDrop(event: DragEvent, target: DropTarget) {
    event.preventDefault()
    const nodeId = event.dataTransfer.getData('text/plain') || draggedId
    setDraggedId(null)
    setDropTarget(null)
    if (!nodeId || !canDropOn(target, nodeId)) return
    moveBranch(nodeId, target)
  }

  function activateDropTarget(event: DragEvent, target: DropTarget) {
    if (!canDropOn(target)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(target)
  }

  function mergeRootsIntoSelectedRoot() {
    if (!selectedNode) return
    const movableRoots = document.nodes.filter((node) => node.id !== selectedNode.id && !contains(node, selectedNode.id))
    if (movableRoots.length === 0) return
    const movableRootIds = new Set(movableRoots.map((node) => node.id))
    const nextNodes = document.nodes
      .filter((node) => !movableRootIds.has(node.id))
      .map((node) =>
        node.id === selectedNode.id
          ? { ...node, children: [...node.children, ...movableRoots] }
          : node,
      )
    emitNodes(nextNodes)
    setExpandedIds((current) => new Set([...current, selectedNode.id]))
  }

  function openProjectMerge() {
    setMergeProjectId(availableProjects[0]?.id ?? '')
    setProjectMergeMode('append-root')
    setErrorMessage('')
    setShowProjectMerge(true)
  }

  function mergeProject() {
    const project = availableProjects.find((item) => item.id === mergeProjectId)
    if (!project) {
      setErrorMessage('Elige un proyecto para unir.')
      return
    }

    if (projectMergeMode === 'append-to-selected' && !selectedNode) {
      setErrorMessage('Selecciona una fase antes de meter el proyecto como subfases.')
      return
    }

    const sourceDocument = normalizeRoadmapDocument(project.document)
    const sourceNodes = applyAutomaticStatuses(sourceDocument.nodes)
    if (sourceNodes.length === 0) {
      setErrorMessage('Ese proyecto no tiene fases para unir.')
      return
    }

    const importedNodes = cloneNodesWithUniqueIds(sourceNodes, collectNodeIds(document.nodes), project.slug || project.name)

    if (projectMergeMode === 'append-to-selected' && selectedNode) {
      emitNodes(updateNode(document.nodes, selectedNode.id, (node) => ({
        ...node,
        children: [...node.children, ...importedNodes],
      })))
      setExpandedIds((current) => new Set([...current, selectedNode.id]))
      setSelectedId(importedNodes[0]?.id ?? selectedNode.id)
    } else {
      emitNodes([...document.nodes, ...importedNodes])
      setSelectedId(importedNodes[0]?.id ?? selectedId)
    }

    setShowProjectMerge(false)
    setMergeProjectId('')
    setErrorMessage('')
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
    downloadText(`${selectedNode.id || 'rama'}.json`, stringifyRoadmapJson({ ...document, ideas: [], nodes: [selectedNode] }))
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
  const printIdeasHtml = document.ideas
    .map((idea) => `<article><h2>${idea.title}</h2>${sanitizeRichText(idea.bodyHtml)}</article>`)
    .join('')
  const printHtml = [
    printIdeasHtml && printScope === 'all'
      ? `<h1>Ideas y comentarios</h1><section class="ideas-print">${printIdeasHtml}</section>`
      : '',
    markdownToHtml(printMarkdown),
  ].filter(Boolean).join('\n')

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
          <button className="tree-toggle" disabled={node.children.length === 0} onClick={() => toggleNodeExpansion(node)} aria-label={expanded ? 'Contraer fase' : 'Expandir fase'} title={expanded ? 'Contraer' : 'Expandir'} type="button">
            {node.children.length === 0 ? null : <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />}
          </button>
          <button className="file-name" onClick={() => selectNode(node)} type="button">
            <span className={`state-dot ${node.status}`} />
            <strong>{node.id || 'sin-id'}</strong>
            <span>{node.title || 'Nueva fase'}</span>
          </button>
          <span className="progress-chip" title={`${progress}% completado`}>{progress}%</span>
          <button aria-label="Copiar fase" className="copy-button" onClick={() => copyText(nodeMarkdown(node))} title="Copiar fase" type="button">
            <Icon name="copy" />
          </button>
          <button aria-label="Mas acciones" className="menu-button" onClick={() => setOpenMenuId(openMenuId === node.id ? null : node.id)} title="Mas acciones" type="button">
            <Icon name="more" />
          </button>
        </div>
        {openMenuId === node.id ? (
          <div className="node-menu">
            <button onClick={() => addNode(node.id)} type="button"><Icon name="plus" /> Hijo</button>
            <button onClick={() => addNode(parentId, index + 1)} type="button"><Icon name="plus" /> Hermano</button>
            <button onClick={() => duplicateNode(node, parentId, index)} type="button"><Icon name="copy" /> Duplicar rama</button>
            <button onClick={() => moveNode(node, parentId, index, -1)} type="button"><Icon name="chevronUp" /> Mover arriba</button>
            <button onClick={() => moveNode(node, parentId, index, 1)} type="button"><Icon name="chevronDown" /> Mover abajo</button>
            <label>
              Cambiar padre
              <select onChange={(event) => changeParent(node, event.target.value)} value={parentId}>
                <option value="">Raíz</option>
                {parentOptions.map(({ node: optionNode }) => (
                  <option key={optionNode.id} value={optionNode.id}>{optionNode.id} — {optionNode.title}</option>
                ))}
              </select>
            </label>
            <button onClick={() => copyText(nodeMarkdown(node))} type="button"><Icon name="copy" /> Copiar fase</button>
            <button onClick={() => copyText(nodeMarkdown(node, 1, true))} type="button"><Icon name="fileBranch" /> Copiar rama</button>
            <button className="text-danger" onClick={() => deleteNode(node)} type="button"><Icon name="trash" /> Eliminar</button>
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

  function sameDropTarget(first: DropTarget | null, second: DropTarget) {
    if (!first || first.type !== second.type) return false
    if (first.type === 'root') return true
    if (first.type === 'child' && second.type === 'child') return first.parentId === second.parentId
    if (first.type === 'sibling' && second.type === 'sibling') {
      return first.parentId === second.parentId && first.index === second.index
    }
    return false
  }

  function renderDropZone(target: DropTarget, label: string) {
    const active = sameDropTarget(dropTarget, target)
    return (
      <div
        className={`canvas-drop-zone ${active ? 'active' : ''}`}
        onDragLeave={() => setDropTarget(null)}
        onDragOver={(event) => activateDropTarget(event, target)}
        onDrop={(event) => handleDrop(event, target)}
      >
        {label}
      </div>
    )
  }

  function renderCanvasNode(item: CanvasNode) {
    const { node, parentId, index, x, y } = item
    const expanded = expandedIds.has(node.id)
    const isSearching = query.trim().length > 0
    const hiddenDescendants = !expanded && !isSearching ? countDescendants(node) : 0
    const progress = nodeProgress(node)
    return (
      <div
        className={`canvas-card ${selectedId === node.id ? 'selected' : ''} ${draggedId === node.id ? 'dragging' : ''}`}
        draggable
        key={`${parentId}-${index}-${node.id}`}
        onClick={() => selectNode(node)}
        onDragEnd={() => {
          setDraggedId(null)
          setDropTarget(null)
        }}
        onDragStart={(event) => handleDragStart(event, node)}
        style={{ left: x, top: y } as CSSProperties}
      >
        {renderDropZone({ type: 'sibling', parentId, index }, 'Antes')}
        <div
          className={`canvas-card-main ${sameDropTarget(dropTarget, { type: 'child', parentId: node.id }) ? 'drop-child' : ''}`}
          onDragOver={(event) => activateDropTarget(event, { type: 'child', parentId: node.id })}
          onDrop={(event) => handleDrop(event, { type: 'child', parentId: node.id })}
          title={`${node.title || 'Nueva fase'} (${node.id || 'sin-id'})`}
        >
          <span className="canvas-grip" title="Arrastrar rama"><Icon name="grip" /></span>
          <button
            aria-label={expanded ? 'Contraer rama' : 'Expandir rama'}
            className="canvas-toggle"
            disabled={node.children.length === 0}
            onClick={(event) => {
              event.stopPropagation()
              toggleNodeExpansion(node)
            }}
            title={expanded ? 'Contraer rama' : 'Expandir rama'}
            type="button"
          >
            {node.children.length === 0 ? null : <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />}
          </button>
          <span className={`state-dot ${node.status}`} />
          <div className="canvas-node-text">
            <strong>{node.title || 'Nueva fase'}</strong>
            <span>{node.id || 'sin-id'}</span>
          </div>
          <span className="canvas-card-meta">
            {hiddenDescendants > 0 ? <span className="hidden-count">+{hiddenDescendants}</span> : null}
            <span className="progress-chip">{progress}%</span>
          </span>
        </div>
        {renderDropZone({ type: 'sibling', parentId, index: index + 1 }, 'Despues')}
      </div>
    )
  }

  function renderIdeasRepository() {
    return (
      <section className="ideas-repository no-print" aria-label="Ideas y comentarios">
        <aside className="ideas-list-panel">
          <div className="ideas-list-toolbar">
            <div>
              <h2>Ideas y comentarios</h2>
              <span>{document.ideas.length} guardadas</span>
            </div>
            <button aria-label="Nueva idea" className="icon-only" onClick={createIdea} title="Nueva idea" type="button">
              <Icon name="plus" />
            </button>
          </div>
          {filteredIdeas.length === 0 ? (
            <p className="empty-state ideas-empty">No hay ideas que coincidan.</p>
          ) : null}
          <ul className="ideas-list">
            {filteredIdeas.map((idea) => (
              <li key={idea.id}>
                <button
                  className={selectedIdea?.id === idea.id ? 'active' : ''}
                  onClick={() => setSelectedIdeaId(idea.id)}
                  type="button"
                >
                  <strong>{idea.title || 'Idea sin titulo'}</strong>
                  <span>{htmlToPlainText(idea.bodyHtml) || 'Sin contenido todavia'}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="idea-detail-panel">
          {selectedIdea ? (
            <>
              <div className="idea-title-row">
                <input
                  aria-label="Titulo de la idea"
                  onChange={(event) => updateIdea(selectedIdea.id, (idea) => ({ ...idea, title: event.target.value }))}
                  value={selectedIdea.title}
                />
                <button
                  aria-label="Eliminar idea"
                  className="icon-only text-danger"
                  onClick={() => deleteIdea(selectedIdea)}
                  title="Eliminar idea"
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </div>
              <div className="rich-toolbar idea-toolbar" role="toolbar" aria-label="Formato de la idea">
                {richTextActions.map((action) => (
                  <button
                    aria-label={action.label}
                    className="icon-only secondary-button"
                    key={`${action.command}-${action.value ?? ''}`}
                    onMouseDown={(event) => formatIdea(event, action)}
                    title={action.label}
                    type="button"
                  >
                    <Icon name={action.icon} />
                  </button>
                ))}
              </div>
              <div
                aria-label="Contenido de la idea"
                className="idea-body-editor"
                contentEditable
                dangerouslySetInnerHTML={{ __html: sanitizeRichText(selectedIdea.bodyHtml) }}
                onBlur={(event) => {
                  const html = sanitizeRichText(event.currentTarget.innerHTML)
                  event.currentTarget.innerHTML = html
                  updateSelectedIdeaBody(html)
                }}
                onInput={handleIdeaInput}
                ref={ideaEditorRef}
                role="textbox"
                suppressContentEditableWarning
              />
            </>
          ) : (
            <div className="idea-empty-detail">
              <h2>Ideas y comentarios</h2>
              <p className="empty-state">Crea una idea para guardar notas, comentarios o decisiones del arbol.</p>
              <button onClick={createIdea} type="button"><Icon name="plus" /> Nueva idea</button>
            </div>
          )}
        </section>
      </section>
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
        <div className="mode-switch" role="group" aria-label="Vista del editor">
          <button className={editorMode === 'editor' ? 'active' : ''} onClick={() => setEditorMode('editor')} type="button"><Icon name="fileBranch" /> Editar</button>
          <button className={editorMode === 'canvas' ? 'active' : ''} onClick={() => setEditorMode('canvas')} type="button"><Icon name="gitMerge" /> Esquema</button>
          <button className={editorMode === 'ideas' ? 'active' : ''} onClick={() => setEditorMode('ideas')} type="button"><Icon name="quote" /> Ideas</button>
        </div>
        <div className="toolbar-group">
          <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
          <button aria-label="Importar JSON" className="icon-only" onClick={() => openImport('replace-project')} title="Importar JSON" type="button"><Icon name="upload" /></button>
          <button aria-label="Exportar proyecto" className="icon-only secondary-button" onClick={exportProject} title="Exportar proyecto" type="button"><Icon name="download" /></button>
          <button aria-label="Exportar rama" className="icon-only secondary-button" onClick={exportBranch} title="Exportar rama" type="button"><Icon name="fileBranch" /></button>
          <button aria-label="Imprimir" className="icon-only secondary-button" onClick={() => setShowPrint(true)} title="Imprimir" type="button"><Icon name="printer" /></button>
        </div>
        <div className="toolbar-group">
          <button aria-label="Volver a proyectos" className="icon-only secondary-button" onClick={onBack} title="Proyectos" type="button"><Icon name="folderOpen" /></button>
          <button aria-label="Cerrar sesion" className="icon-only secondary-button" onClick={onSignOut} title="Cerrar sesion" type="button"><Icon name="logOut" /></button>
        </div>
      </header>

      {errorMessage ? <p className="form-error no-print">{errorMessage}</p> : null}

      {editorMode === 'canvas' ? (
        <section className="branch-canvas-panel full-screen no-print" aria-label="Editor visual de ramas">
            <div className="canvas-toolbar">
              <button className="secondary-button" onClick={() => setEditorMode('editor')} type="button"><Icon name="arrowLeft" /> Editar</button>
              <button onClick={() => addNode('')} type="button"><Icon name="plus" /> Raiz</button>
              <button
                className="secondary-button"
                disabled={!selectedNode}
                onClick={() => selectedNode && addNode(selectedNode.id)}
                type="button"
              >
                <Icon name="plus" /> Hijo
              </button>
              <button
                className="secondary-button"
                disabled={!selectedNode}
                onClick={() => selectedNode && addNode(selectedFlatNode?.parentId ?? '', (selectedFlatNode?.index ?? 0) + 1)}
                type="button"
              >
                <Icon name="plus" /> Hermano
              </button>
              <button
                className="secondary-button"
                disabled={!selectedNode || document.nodes.length < 2}
                onClick={mergeRootsIntoSelectedRoot}
                type="button"
              >
                <Icon name="gitMerge" /> Unir raices
              </button>
              <button
                className="secondary-button"
                disabled={availableProjects.length === 0}
                onClick={openProjectMerge}
                type="button"
              >
                <Icon name="gitMerge" /> Unir proyecto
              </button>
            </div>
            <div
              className="canvas-root-drop"
              onDragLeave={() => setDropTarget(null)}
              onDragOver={(event) => activateDropTarget(event, { type: 'root' })}
              onDrop={(event) => handleDrop(event, { type: 'root' })}
            >
              Soltar aqui para separar como raiz
            </div>
            <div className="branch-canvas-scroll">
              <div className="branch-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
                <svg className="canvas-lines" height={canvasHeight} width={canvasWidth} aria-hidden="true">
                  {canvasNodes.map((item) => {
                    if (!item.parentId) return null
                    const parent = canvasLookup.get(item.parentId)
                    if (!parent) return null
                    const startX = parent.x + canvasNodeWidth
                    const startY = parent.y + canvasNodeHeight / 2
                    const endX = item.x
                    const endY = item.y + canvasNodeHeight / 2
                    const midX = startX + (endX - startX) / 2
                    return (
                      <path
                        d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                        key={`${item.parentId}-${item.node.id}`}
                      />
                    )
                  })}
                </svg>
                {canvasNodes.map(renderCanvasNode)}
              </div>
            </div>
          </section>
      ) : editorMode === 'ideas' ? (
        renderIdeasRepository()
      ) : (
        <section className="roadmap-body">
          <aside className="file-tree no-print">
            <div className="tree-mini-actions">
              <button aria-label="Añadir raiz" className="icon-only" onClick={() => addNode('')} title="Añadir raiz" type="button"><Icon name="plus" /></button>
              <button aria-label="Expandir todo" className="icon-only secondary-button" onClick={() => setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))} title="Expandir todo" type="button"><Icon name="maximize" /></button>
              <button aria-label="Contraer todo" className="icon-only secondary-button" onClick={() => setExpandedIds(new Set())} title="Contraer todo" type="button"><Icon name="minimize" /></button>
              <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
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
                <button onClick={() => addNode(selectedNode.id)} type="button"><Icon name="plus" /> Subfase</button>
                <button
                  className="secondary-button"
                  onClick={() => addNode(selectedFlatNode?.parentId ?? '', (selectedFlatNode?.index ?? 0) + 1)}
                  type="button"
                >
                  <Icon name="plus" /> Hermana
                </button>
                <button aria-label="Importar como subfases" className="icon-only secondary-button" onClick={() => openImport('append-to-selected')} title="Importar como subfases" type="button"><Icon name="upload" /></button>
                <button aria-label="Reemplazar esta rama" className="icon-only secondary-button" onClick={() => openImport('replace-selected')} title="Reemplazar esta rama" type="button"><Icon name="import" /></button>
                <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
                <button aria-label="Cerrar fase" className="icon-only secondary-button" disabled={selectedNode.status === 'closed'} onClick={() => closeNode(selectedNode)} title="Cerrar fase" type="button"><Icon name="check" /></button>
                <button aria-label="Copiar JSON" className="icon-only secondary-button" onClick={copySelectedJson} title="Copiar JSON" type="button"><Icon name="copy" /></button>
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
      )}

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

      {showProjectMerge ? (
        <div className="modal-backdrop no-print">
          <section className="modal compact">
            <h2>Unir proyecto</h2>
            <label className="field-label">
              Proyecto
              <select onChange={(event) => setMergeProjectId(event.target.value)} value={mergeProjectId}>
                {availableProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <div className="import-modes" role="group" aria-label="Destino del proyecto">
              <label>
                <input
                  checked={projectMergeMode === 'append-root'}
                  name="project-merge-mode"
                  onChange={() => setProjectMergeMode('append-root')}
                  type="radio"
                />
                Sumar como raices nuevas
              </label>
              <label>
                <input
                  checked={projectMergeMode === 'append-to-selected'}
                  disabled={!selectedNode}
                  name="project-merge-mode"
                  onChange={() => setProjectMergeMode('append-to-selected')}
                  type="radio"
                />
                Meter como subfases de la fase seleccionada
              </label>
            </div>
            {selectedNode ? (
              <p className="modal-hint">Seleccionada: {selectedNode.id || 'sin-id'} — {selectedNode.title || 'Nueva fase'}</p>
            ) : null}
            <div className="modal-actions">
              <button disabled={!mergeProjectId} onClick={mergeProject} type="button">Unir</button>
              <button className="secondary-button" onClick={() => setShowProjectMerge(false)} type="button">Cancelar</button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="print-surface" dangerouslySetInnerHTML={{ __html: printHtml }} />
    </main>
  )
}
