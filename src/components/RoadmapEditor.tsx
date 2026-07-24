import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import type {
  RoadmapDocument,
  RoadmapDocumentRef,
  RoadmapNode,
  RoadmapNodeStatus,
} from '../types/roadmap'

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'
type ImportMode = 'replace' | 'child' | 'sibling'
type PrintMode = 'hierarchy' | 'tree'

type RoadmapEditorProps = {
  document: RoadmapDocument
  syncError: string
  syncStatus: SyncStatus
  onChange: (document: RoadmapDocument) => void
  onImportAsProject: (document: RoadmapDocument) => void
}

type FlatNode = {
  node: RoadmapNode
  parentId: string
  depth: number
  index: number
  path: RoadmapNode[]
}

type ValidationResult = {
  errors: string[]
  warnings: string[]
}

type PrintOptions = {
  mode: PrintMode
  scope: 'selected' | 'branch' | 'roadmap' | 'filtered'
  includeDescription: boolean
  includeNotes: boolean
  includeDocuments: boolean
  includeCommits: boolean
  includeDependencies: boolean
  includeStatuses: boolean
  maxDepth: number
}

const statusOptions: Array<{ label: string; value: RoadmapNodeStatus }> = [
  { label: 'Pendiente', value: 'pending' },
  { label: 'En curso', value: 'in_progress' },
  { label: 'Hecho', value: 'done' },
  { label: 'Bloqueado', value: 'blocked' },
]

const allowedStatuses = new Set(statusOptions.map(({ value }) => value))

const defaultPrintOptions: PrintOptions = {
  mode: 'hierarchy',
  scope: 'roadmap',
  includeDescription: true,
  includeNotes: true,
  includeDocuments: true,
  includeCommits: true,
  includeDependencies: true,
  includeStatuses: true,
  maxDepth: 12,
}

function createNode(seed: string): RoadmapNode {
  return {
    id: seed,
    title: 'Nuevo nodo',
    status: 'pending',
    objective: '',
    description: '',
    expectedResult: '',
    inScope: [],
    outOfScope: [],
    dependencies: [],
    documents: [],
    commits: [],
    notes: '',
    children: [],
  }
}

function normalizeNode(value: Partial<RoadmapNode> & Record<string, unknown>): RoadmapNode {
  return {
    ...createNode(String(value.id || `nodo-${Date.now().toString(36)}`)),
    id: String(value.id || ''),
    title: String(value.title || ''),
    status: allowedStatuses.has(value.status as RoadmapNodeStatus)
      ? (value.status as RoadmapNodeStatus)
      : 'pending',
    objective: String(value.objective ?? value.goal ?? ''),
    description: String(value.description ?? ''),
    expectedResult: String(value.expectedResult ?? value.expectedOutcome ?? ''),
    inScope: Array.isArray(value.inScope) ? value.inScope.map(String) : [],
    outOfScope: Array.isArray(value.outOfScope) ? value.outOfScope.map(String) : [],
    dependencies: Array.isArray(value.dependencies)
      ? value.dependencies.map(String).filter(Boolean)
      : [],
    documents: Array.isArray(value.documents)
      ? value.documents.map((document) => {
          if (typeof document === 'string') {
            return { title: document, href: document }
          }

          const ref = document as Partial<RoadmapDocumentRef>
          return {
            title: String(ref.title ?? ''),
            href: String(ref.href ?? ''),
          }
        })
      : [],
    commits: Array.isArray(value.commits) ? value.commits.map(String) : [],
    notes: String(value.notes ?? ''),
    children: Array.isArray(value.children)
      ? value.children.map((child) => normalizeNode(child as Record<string, unknown>))
      : [],
  }
}

export function normalizeRoadmapDocument(value: unknown): RoadmapDocument {
  const input = value as Partial<RoadmapDocument>
  return {
    schemaVersion: 1,
    project: {
      id: String(input.project?.id || 'roadmap-importado'),
      name: String(input.project?.name || 'Roadmap importado'),
    },
    nodes: Array.isArray(input.nodes)
      ? input.nodes.map((node) => normalizeNode(node as Record<string, unknown>))
      : [],
  }
}

export function parseRoadmapJson(value: string): {
  document: RoadmapDocument | null
  errors: string[]
} {
  try {
    const parsed = JSON.parse(value) as unknown
    const validation = validateRoadmapDocument(parsed)
    if (validation.errors.length > 0) {
      return { document: null, errors: validation.errors }
    }

    return { document: normalizeRoadmapDocument(parsed), errors: [] }
  } catch (error) {
    return {
      document: null,
      errors: [error instanceof Error ? error.message : 'JSON invalido'],
    }
  }
}

export function stringifyRoadmapJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'roadmap'
  )
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

function linesToList(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function listToLines(value: string[]) {
  return value.join('\n')
}

function documentsToLines(value: RoadmapDocumentRef[]) {
  return value.map((document) => `${document.title} | ${document.href}`).join('\n')
}

function linesToDocuments(value: string): RoadmapDocumentRef[] {
  return linesToList(value).map((line) => {
    const [title, ...hrefParts] = line.split('|')
    const href = hrefParts.join('|').trim()
    return {
      title: title.trim(),
      href: href || title.trim(),
    }
  })
}

function walkNodes(
  nodes: RoadmapNode[],
  callback: (
    node: RoadmapNode,
    parentId: string,
    depth: number,
    index: number,
    path: RoadmapNode[],
  ) => void,
  parentId = '',
  depth = 0,
  path: RoadmapNode[] = [],
) {
  nodes.forEach((node, index) => {
    const nextPath = [...path, node]
    callback(node, parentId, depth, index, nextPath)
    walkNodes(node.children, callback, node.id, depth + 1, nextPath)
  })
}

function flattenNodes(nodes: RoadmapNode[]) {
  const flatNodes: FlatNode[] = []
  walkNodes(nodes, (node, parentId, depth, index, path) => {
    flatNodes.push({ node, parentId, depth, index, path })
  })
  return flatNodes
}

function findNode(nodes: RoadmapNode[], nodeId: string): RoadmapNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node
    const childNode = findNode(node.children, nodeId)
    if (childNode) return childNode
  }

  return null
}

function containsNode(node: RoadmapNode, nodeId: string): boolean {
  return node.id === nodeId || node.children.some((child) => containsNode(child, nodeId))
}

function updateNode(
  nodes: RoadmapNode[],
  nodeId: string,
  updater: (node: RoadmapNode) => RoadmapNode,
): RoadmapNode[] {
  return nodes.map((node) => {
    if (node.id === nodeId) return updater(node)

    return {
      ...node,
      children: updateNode(node.children, nodeId, updater),
    }
  })
}

function insertNode(
  nodes: RoadmapNode[],
  parentId: string,
  nodeToInsert: RoadmapNode,
  index?: number,
): RoadmapNode[] {
  if (!parentId) {
    const nextNodes = [...nodes]
    nextNodes.splice(index ?? nextNodes.length, 0, nodeToInsert)
    return nextNodes
  }

  return updateNode(nodes, parentId, (node) => {
    const nextChildren = [...node.children]
    nextChildren.splice(index ?? nextChildren.length, 0, nodeToInsert)
    return { ...node, children: nextChildren }
  })
}

function removeNode(nodes: RoadmapNode[], nodeId: string): RoadmapNode[] {
  return nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => ({
      ...node,
      children: removeNode(node.children, nodeId),
    }))
}

function cloneNode(node: RoadmapNode, suffix: string): RoadmapNode {
  return {
    ...node,
    id: `${node.id}-${suffix}`,
    title: `${node.title} copia`,
    children: node.children.map((child, index) => cloneNode(child, `${suffix}-${index + 1}`)),
  }
}

function getBranchIds(node: RoadmapNode) {
  const ids = [node.id]
  node.children.forEach((child) => ids.push(...getBranchIds(child)))
  return ids
}

function collectIds(nodes: RoadmapNode[]) {
  return flattenNodes(nodes).map(({ node }) => node.id)
}

function statusLabel(status: RoadmapNodeStatus) {
  return statusOptions.find((option) => option.value === status)?.label ?? status
}

function syncLabel(syncStatus: SyncStatus) {
  if (syncStatus === 'local') return 'Guardado localmente'
  if (syncStatus === 'syncing') return 'Sincronizando'
  if (syncStatus === 'synced') return 'Sincronizado'
  return 'Error'
}

function nodeMatchesContent(node: RoadmapNode, query: string) {
  const haystack = [
    node.id,
    node.title,
    node.objective,
    node.description,
    node.expectedResult,
    node.inScope.join(' '),
    node.outOfScope.join(' '),
    node.dependencies.join(' '),
    node.documents.map((document) => `${document.title} ${document.href}`).join(' '),
    node.commits.join(' '),
    node.notes,
  ]
    .join(' ')
    .toLowerCase()

  return haystack.includes(query.toLowerCase())
}

export function validateRoadmapDocument(value: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const input = value as Partial<RoadmapDocument>

  if (!input || typeof input !== 'object') {
    return { errors: ['El documento debe ser un objeto.'], warnings }
  }

  if (input.schemaVersion !== 1) {
    errors.push('schemaVersion debe ser 1.')
  }

  if (!input.project || typeof input.project !== 'object') {
    errors.push('project debe ser un objeto valido.')
  } else {
    if (!input.project.id) errors.push('project.id es obligatorio.')
    if (!input.project.name) errors.push('project.name es obligatorio.')
  }

  if (!Array.isArray(input.nodes)) {
    errors.push('nodes debe ser un array.')
    return { errors, warnings }
  }

  const ids = new Set<string>()
  const stack = new Set<RoadmapNode>()
  const dependencies: Array<{ id: string; dependency: string }> = []
  let inProgressCount = 0

  function validateNode(rawNode: unknown, parentId: string, depth: number) {
    if (!rawNode || typeof rawNode !== 'object') {
      errors.push('Cada nodo debe ser un objeto.')
      return
    }

    const node = rawNode as Partial<RoadmapNode>
    if (!node.id) {
      errors.push('ID ausente.')
    } else if (ids.has(node.id)) {
      errors.push(`ID duplicado: ${node.id}.`)
    } else {
      ids.add(node.id)
    }

    if (!node.title) warnings.push(`Nodo sin titulo: ${node.id || '(sin ID)'}.`)
    if (!allowedStatuses.has(node.status as RoadmapNodeStatus)) {
      errors.push(`Estado invalido en ${node.id || '(sin ID)'}.`)
    }

    if (!Array.isArray(node.children)) {
      errors.push(`children invalido en ${node.id || '(sin ID)'}.`)
      return
    }

    if (node.id && parentId && !node.id.startsWith(`${parentId}.`)) {
      warnings.push(`ID que no sigue la jerarquia de su padre: ${node.id}.`)
    }

    if (depth > 12) warnings.push(`Profundidad superior a 12 en ${node.id}.`)
    if (node.status === 'in_progress') inProgressCount += 1
    if (node.status === 'done' && (!Array.isArray(node.commits) || node.commits.length === 0)) {
      warnings.push(`Fase cerrada sin commit: ${node.id}.`)
    }

    if (Array.isArray(node.dependencies)) {
      node.dependencies.forEach((dependency) => {
        dependencies.push({ id: String(node.id || ''), dependency: String(dependency) })
      })
    }

    if (stack.has(node as RoadmapNode)) {
      errors.push(`Ciclo estructural en ${node.id || '(sin ID)'}.`)
      return
    }

    stack.add(node as RoadmapNode)
    node.children.forEach((child) => validateNode(child, String(node.id || ''), depth + 1))
    stack.delete(node as RoadmapNode)
  }

  input.nodes.forEach((node) => validateNode(node, '', 0))
  dependencies.forEach(({ id, dependency }) => {
    if (dependency === id) errors.push(`Dependencia consigo misma: ${id}.`)
    if (!ids.has(dependency)) errors.push(`Dependencia inexistente en ${id}: ${dependency}.`)
    const dependencyNode = findNode((input.nodes ?? []) as RoadmapNode[], dependency)
    if (dependencyNode && dependencyNode.status !== 'done') {
      warnings.push(`Dependencia no cerrada en ${id}: ${dependency}.`)
    }
  })

  if (inProgressCount > 1) warnings.push('Mas de una fase en curso.')

  return { errors, warnings }
}

function nodeToMarkdown(node: RoadmapNode, depth: number, includeChildren: boolean): string {
  const lines: string[] = []
  const headingLevel = Math.min(depth + 2, 6)
  lines.push(`${'#'.repeat(headingLevel)} ${node.id} — ${node.title}`)
  lines.push('')
  lines.push(`**Estado:** ${statusLabel(node.status)}`)
  if (node.dependencies.length) {
    lines.push('', '**Dependencias**', ...node.dependencies.map((dependency) => `- ${dependency}`))
  }
  if (node.objective) lines.push('', '**Objetivo**', '', node.objective)
  if (node.description) lines.push('', '**Descripcion**', '', node.description)
  if (node.inScope.length) lines.push('', '**Dentro de alcance**', ...node.inScope.map((item) => `- ${item}`))
  if (node.outOfScope.length) lines.push('', '**Fuera de alcance**', ...node.outOfScope.map((item) => `- ${item}`))
  if (node.expectedResult) lines.push('', '**Resultado esperado**', '', node.expectedResult)
  if (node.documents.length) {
    lines.push('', '**Documentos**')
    node.documents.forEach((document) => lines.push(`- ${document.title}: ${document.href}`))
  }
  if (node.commits.length) lines.push('', '**Commits**', ...node.commits.map((commit) => `- ${commit}`))
  if (node.notes) lines.push('', '**Notas**', '', node.notes)
  lines.push('')
  if (includeChildren) {
    node.children.forEach((child) => lines.push(nodeToMarkdown(child, depth + 1, true)))
  }
  return lines.join('\n')
}

function codexContext(node: RoadmapNode, title = 'Fase actual') {
  const lines: string[] = [`# ${title}`, '', `${node.id} — ${node.title}`, '']
  lines.push('## Estado', '', statusLabel(node.status), '')
  if (node.dependencies.length) {
    lines.push('## Dependencias', '', ...node.dependencies.map((dependency) => `- ${dependency}`), '')
  }
  if (node.objective) lines.push('## Objetivo', '', node.objective, '')
  if (node.inScope.length) lines.push('## Dentro de alcance', '', ...node.inScope.map((item) => `- ${item}`), '')
  if (node.outOfScope.length) lines.push('## Fuera de alcance', '', ...node.outOfScope.map((item) => `- ${item}`), '')
  if (node.expectedResult) lines.push('## Resultado esperado', '', node.expectedResult, '')
  if (node.documents.length) {
    lines.push('## Documentos', '')
    node.documents.forEach((document) => lines.push(`- ${document.title}: ${document.href}`))
    lines.push('')
  }
  if (node.description) lines.push('## Descripcion', '', node.description, '')
  if (node.notes) lines.push('## Notas', '', node.notes, '')
  return lines.join('\n').trim() + '\n'
}

export function RoadmapEditor({
  document,
  onChange,
  onImportAsProject,
  syncError,
  syncStatus,
}: RoadmapEditorProps) {
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<RoadmapNodeStatus>>(() => new Set())
  const [showLeavesOnly, setShowLeavesOnly] = useState(false)
  const [showBranchesOnly, setShowBranchesOnly] = useState(false)
  const [showWithDocumentsOnly, setShowWithDocumentsOnly] = useState(false)
  const [showWithCommitsOnly, setShowWithCommitsOnly] = useState(false)
  const [showSelectedBranchOnly, setShowSelectedBranchOnly] = useState(false)
  const [maxDepth, setMaxDepth] = useState(12)
  const [history, setHistory] = useState<string[]>([])
  const [importText, setImportText] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [validation, setValidation] = useState<ValidationResult>({ errors: [], warnings: [] })
  const [markdownPreview, setMarkdownPreview] = useState('')
  const [printOptions, setPrintOptions] = useState<PrintOptions>(defaultPrintOptions)
  const [draggedNodeId, setDraggedNodeId] = useState('')

  const flatNodes = useMemo(() => flattenNodes(document.nodes), [document.nodes])
  const selectedNode = selectedNodeId ? findNode(document.nodes, selectedNodeId) : null
  const selectedFlatNode = flatNodes.find(({ node }) => node.id === selectedNodeId)
  const selectedPath = selectedFlatNode?.path ?? []

  useEffect(() => {
    if (!selectedNode && flatNodes[0]) setSelectedNodeId(flatNodes[0].node.id)
    if (expandedIds.size === 0 && flatNodes.length > 0) {
      setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))
    }
  }, [expandedIds.size, flatNodes, selectedNode])

  function emit(nextDocument: RoadmapDocument) {
    onChange(nextDocument)
  }

  function emitNodes(nodes: RoadmapNode[]) {
    emit({ ...document, nodes })
  }

  function rememberNode(nodeId: string) {
    setSelectedNodeId(nodeId)
    setHistory((current) => [nodeId, ...current.filter((item) => item !== nodeId)].slice(0, 20))
  }

  function createUniqueNode(prefix = 'nodo') {
    const existingIds = new Set(collectIds(document.nodes))
    let candidate = `${prefix}-${Date.now().toString(36)}`
    let counter = 1
    while (existingIds.has(candidate)) {
      candidate = `${prefix}-${Date.now().toString(36)}-${counter}`
      counter += 1
    }
    return createNode(candidate)
  }

  function handleAddRoot() {
    const nextNode = createUniqueNode('raiz')
    emitNodes(insertNode(document.nodes, '', nextNode))
    rememberNode(nextNode.id)
  }

  function handleAddChild() {
    if (!selectedNode) return
    const nextNode = createUniqueNode(`${selectedNode.id}.hijo`)
    emitNodes(insertNode(document.nodes, selectedNode.id, nextNode))
    setExpandedIds((currentIds) => new Set([...currentIds, selectedNode.id]))
    rememberNode(nextNode.id)
  }

  function handleAddSibling() {
    if (!selectedFlatNode) {
      handleAddRoot()
      return
    }
    const nextNode = createUniqueNode(`${selectedFlatNode.node.id}.hermano`)
    emitNodes(insertNode(document.nodes, selectedFlatNode.parentId, nextNode, selectedFlatNode.index + 1))
    rememberNode(nextNode.id)
  }

  function handleDuplicate() {
    if (!selectedNode || !selectedFlatNode) return
    const duplicatedNode = cloneNode(selectedNode, Date.now().toString(36))
    emitNodes(insertNode(document.nodes, selectedFlatNode.parentId, duplicatedNode, selectedFlatNode.index + 1))
    rememberNode(duplicatedNode.id)
  }

  function handleDelete() {
    if (!selectedNode) return
    if (!window.confirm(`Eliminar "${selectedNode.title}" y sus hijos?`)) return
    emitNodes(removeNode(document.nodes, selectedNode.id))
    setSelectedNodeId('')
  }

  function handleSelectedNodeChange<K extends keyof RoadmapNode>(key: K, value: RoadmapNode[K]) {
    if (!selectedNode) return
    emitNodes(updateNode(document.nodes, selectedNode.id, (node) => ({ ...node, [key]: value })))
    if (key === 'id') rememberNode(String(value))
  }

  function handleMove(parentId: string, position: number) {
    if (!selectedNode || !selectedFlatNode) return
    if (parentId === selectedNode.id || containsNode(selectedNode, parentId)) return
    const nodesWithoutSelected = removeNode(document.nodes, selectedNode.id)
    const nextPosition =
      selectedFlatNode.parentId === parentId && selectedFlatNode.index < position ? position - 1 : position
    emitNodes(insertNode(nodesWithoutSelected, parentId, selectedNode, nextPosition))
  }

  function handleDrop(parentId: string, index?: number) {
    if (!draggedNodeId) return
    const draggedNode = findNode(document.nodes, draggedNodeId)
    if (!draggedNode || parentId === draggedNode.id || containsNode(draggedNode, parentId)) return
    emitNodes(insertNode(removeNode(document.nodes, draggedNodeId), parentId, draggedNode, index))
    setDraggedNodeId('')
  }

  function importDocument(mode: ImportMode) {
    const result = parseRoadmapJson(importText)
    setImportErrors(result.errors)
    if (!result.document) return

    if (mode === 'replace') {
      emit(result.document)
      setImportText('')
      return
    }

    const importedNodes = result.document.nodes
    if (importedNodes.length === 0) {
      setImportErrors(['El JSON importado no contiene nodos.'])
      return
    }

    if (mode === 'child') {
      if (!selectedNode) {
        setImportErrors(['Selecciona un nodo para insertar la rama como hija.'])
        return
      }
      let nextNodes = document.nodes
      importedNodes.forEach((node) => {
        nextNodes = insertNode(nextNodes, selectedNode.id, node)
      })
      emitNodes(nextNodes)
      setExpandedIds((currentIds) => new Set([...currentIds, selectedNode.id]))
    } else {
      let nextNodes = document.nodes
      importedNodes.forEach((node, offset) => {
        nextNodes = insertNode(
          nextNodes,
          selectedFlatNode?.parentId ?? '',
          node,
          selectedFlatNode ? selectedFlatNode.index + 1 + offset : undefined,
        )
      })
      emitNodes(nextNodes)
    }
    setImportText('')
  }

  function importAsProject() {
    const result = parseRoadmapJson(importText)
    setImportErrors(result.errors)
    if (!result.document) return
    onImportAsProject(result.document)
    setImportText('')
  }

  function exportJson(scope: 'project' | 'branch', copy: boolean) {
    const payload =
      scope === 'project'
        ? document
        : selectedNode
          ? { ...document, nodes: [selectedNode] }
          : null
    if (!payload) return
    const text = stringifyRoadmapJson(payload)
    if (copy) {
      copyText(text)
    } else {
      downloadText(`${slugify(document.project.name)}-${scope}.json`, text)
    }
  }

  function makeMarkdown(scope: 'selected' | 'branch' | 'roadmap' | 'visible') {
    const lines = [`# ${document.project.name}`, '']
    const nodes =
      scope === 'selected'
        ? selectedNode
          ? [selectedNode]
          : []
        : scope === 'branch'
          ? selectedNode
            ? [selectedNode]
            : []
          : scope === 'visible'
            ? visibleFlatNodes.map(({ node }) => node)
            : document.nodes
    nodes.forEach((node) => lines.push(nodeToMarkdown(node, 0, scope !== 'selected' && scope !== 'visible')))
    return lines.join('\n').trim() + '\n'
  }

  function copyNodeAction(action: string) {
    if (!selectedNode) return
    const branchJson = stringifyRoadmapJson({ ...document, nodes: [selectedNode] })
    const selectedMarkdown = nodeToMarkdown(selectedNode, 0, false)
    const branchMarkdown = nodeToMarkdown(selectedNode, 0, true)
    const path = selectedPath.map((node) => `${node.id} — ${node.title}`).join(' > ')
    const ancestors = selectedPath.slice(0, -1).map((node) => codexContext(node, 'Ancestro')).join('\n')
    const descendants = selectedNode.children.map((node) => codexContext(node, 'Descendiente')).join('\n')
    const complete = `${ancestors}\n${codexContext(selectedNode)}\n${descendants}`.trim() + '\n'
    const map: Record<string, string> = {
      id: selectedNode.id,
      idTitle: `${selectedNode.id} — ${selectedNode.title}`,
      phaseMarkdown: selectedMarkdown,
      branchMarkdown,
      phaseJson: stringifyRoadmapJson(selectedNode),
      branchJson,
      path,
      codex: codexContext(selectedNode),
      codexAncestors: `${ancestors}\n${codexContext(selectedNode)}`.trim() + '\n',
      codexDescendants: `${codexContext(selectedNode)}\n${descendants}`.trim() + '\n',
      codexComplete: complete,
    }
    copyText(map[action])
  }

  function validateCurrentRoadmap() {
    setValidation(validateRoadmapDocument(document))
  }

  function toggleStatusFilter(status: RoadmapNodeStatus) {
    setStatusFilters((current) => {
      const next = new Set(current)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  function toggleExpanded(nodeId: string) {
    setExpandedIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(nodeId)) nextIds.delete(nodeId)
      else nextIds.add(nodeId)
      return nextIds
    })
  }

  function expandAll() {
    setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))
  }

  function collapseAll() {
    setExpandedIds(new Set())
  }

  const branchIdSet = useMemo(
    () => new Set(selectedNode && showSelectedBranchOnly ? getBranchIds(selectedNode) : collectIds(document.nodes)),
    [document.nodes, selectedNode, showSelectedBranchOnly],
  )

  const visibleFlatNodes = useMemo(() => {
    return flatNodes.filter(({ node, depth }) => {
      if (depth > maxDepth) return false
      if (!branchIdSet.has(node.id)) return false
      if (query.trim() && !nodeMatchesContent(node, query.trim())) return false
      if (statusFilters.size > 0 && !statusFilters.has(node.status)) return false
      if (showLeavesOnly && node.children.length > 0) return false
      if (showBranchesOnly && node.children.length === 0) return false
      if (showWithDocumentsOnly && node.documents.length === 0) return false
      if (showWithCommitsOnly && node.commits.length === 0) return false
      return true
    })
  }, [
    branchIdSet,
    flatNodes,
    maxDepth,
    query,
    showBranchesOnly,
    showLeavesOnly,
    showWithCommitsOnly,
    showWithDocumentsOnly,
    statusFilters,
  ])

  const visibleIds = useMemo(() => new Set(visibleFlatNodes.map(({ node }) => node.id)), [visibleFlatNodes])

  useEffect(() => {
    if (!query.trim()) return
    const ancestorIds = new Set(expandedIds)
    visibleFlatNodes.forEach(({ path }) => {
      path.slice(0, -1).forEach((node) => ancestorIds.add(node.id))
    })
    setExpandedIds(ancestorIds)
  }, [query])

  function renderNode(node: RoadmapNode, depth = 0) {
    const branchHasVisibleNode = getBranchIds(node).some((id) => visibleIds.has(id))
    if (!branchHasVisibleNode) return null
    const isExpanded = expandedIds.has(node.id)

    return (
      <li
        key={node.id}
        draggable
        onDragOver={(event) => event.preventDefault()}
        onDragStart={() => setDraggedNodeId(node.id)}
        onDrop={() => handleDrop(node.id)}
      >
        <div
          className={`tree-node ${node.id === selectedNodeId ? 'selected' : ''}`}
          style={{ '--depth': depth } as CSSProperties}
        >
          <button
            aria-label={isExpanded ? 'Contraer rama' : 'Expandir rama'}
            className="icon-button"
            disabled={node.children.length === 0}
            onClick={() => toggleExpanded(node.id)}
            type="button"
          >
            {node.children.length === 0 ? '-' : isExpanded ? 'v' : '>'}
          </button>
          <button className="tree-node-main" onClick={() => rememberNode(node.id)} type="button">
            <strong>{node.title || '(sin titulo)'}</strong>
            <span>{node.id || '(sin ID)'}</span>
          </button>
          <button
            aria-label={`Copiar ${node.id}`}
            className="copy-chip"
            onClick={() => copyText(`${node.id} — ${node.title}`)}
            type="button"
          >
            Copiar
          </button>
          <span className={`status-pill ${node.status}`}>{statusLabel(node.status)}</span>
        </div>
        {isExpanded && node.children.length > 0 ? (
          <ul className="tree-list">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    )
  }

  const parentOptions = flatNodes.filter(({ node }) => {
    if (!selectedNode) return false
    return node.id !== selectedNode.id && !containsNode(selectedNode, node.id)
  })
  const currentParentId = selectedFlatNode?.parentId ?? ''
  const siblingCount =
    currentParentId === '' ? document.nodes.length : findNode(document.nodes, currentParentId)?.children.length ?? 0

  const printMarkdown = makeMarkdown(printOptions.scope === 'filtered' ? 'visible' : printOptions.scope === 'branch' ? 'branch' : printOptions.scope === 'selected' ? 'selected' : 'roadmap')

  function openPrintView() {
    window.print()
  }

  return (
    <section className="roadmap-editor">
      <div className="editor-toolbar">
        <div>
          <p className="eyebrow">Arbol</p>
          <input
            aria-label="Nombre del proyecto"
            className="project-title-input"
            onChange={(event) =>
              emit({
                ...document,
                project: { ...document.project, name: event.target.value },
              })
            }
            value={document.project.name}
          />
        </div>
        <div className={`sync-state ${syncStatus}`}>
          {syncLabel(syncStatus)}
          {syncError ? <span>{syncError}</span> : null}
        </div>
      </div>

      <div className="tree-actions no-print">
        <button onClick={handleAddRoot} type="button">Anadir raiz</button>
        <button disabled={!selectedNode} onClick={handleAddChild} type="button">Anadir hijo</button>
        <button onClick={handleAddSibling} type="button">Anadir hermano</button>
        <button disabled={!selectedNode} onClick={handleDuplicate} type="button">Duplicar</button>
        <button className="text-danger" disabled={!selectedNode} onClick={handleDelete} type="button">Eliminar</button>
        <button className="secondary-button" onClick={validateCurrentRoadmap} type="button">Validar roadmap</button>
      </div>

      <div className="import-export-panel no-print">
        <textarea
          aria-label="Pegar JSON"
          onChange={(event) => setImportText(event.target.value)}
          placeholder="Pegar JSON"
          value={importText}
        />
        <div className="tree-actions">
          <button onClick={importAsProject} type="button">Importar como proyecto</button>
          <button onClick={() => importDocument('replace')} type="button">Sustituir actual</button>
          <button disabled={!selectedNode} onClick={() => importDocument('child')} type="button">Insertar hija</button>
          <button onClick={() => importDocument('sibling')} type="button">Insertar hermana</button>
          <button onClick={() => exportJson('project', false)} type="button">Descargar JSON</button>
          <button disabled={!selectedNode} onClick={() => exportJson('branch', false)} type="button">Descargar rama JSON</button>
          <button onClick={() => exportJson('project', true)} type="button">Copiar JSON</button>
          <button disabled={!selectedNode} onClick={() => exportJson('branch', true)} type="button">Copiar rama JSON</button>
        </div>
        {importErrors.length > 0 ? (
          <div className="validation-box error-list">{importErrors.map((error) => <p key={error}>{error}</p>)}</div>
        ) : null}
      </div>

      <div className="navigation-panel no-print">
        <input
          aria-label="Buscar por ID, titulo o contenido"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar por ID, titulo o contenido"
          type="search"
          value={query}
        />
        <div className="filter-row">
          {statusOptions.map((option) => (
            <label key={option.value} className="check-label">
              <input
                checked={statusFilters.has(option.value)}
                onChange={() => toggleStatusFilter(option.value)}
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
          <label className="check-label"><input checked={showLeavesOnly} onChange={(event) => setShowLeavesOnly(event.target.checked)} type="checkbox" />Solo hojas</label>
          <label className="check-label"><input checked={showBranchesOnly} onChange={(event) => setShowBranchesOnly(event.target.checked)} type="checkbox" />Solo ramas</label>
          <label className="check-label"><input checked={showWithDocumentsOnly} onChange={(event) => setShowWithDocumentsOnly(event.target.checked)} type="checkbox" />Con documentos</label>
          <label className="check-label"><input checked={showWithCommitsOnly} onChange={(event) => setShowWithCommitsOnly(event.target.checked)} type="checkbox" />Con commits</label>
          <label className="check-label"><input checked={showSelectedBranchOnly} onChange={(event) => setShowSelectedBranchOnly(event.target.checked)} type="checkbox" />Solo rama seleccionada</label>
          <label className="compact-label">Profundidad <input min={0} max={24} onChange={(event) => setMaxDepth(Number(event.target.value))} type="number" value={maxDepth} /></label>
        </div>
        <div className="tree-actions">
          <button className="secondary-button" onClick={expandAll} type="button">Expandir todo</button>
          <button className="secondary-button" onClick={collapseAll} type="button">Contraer todo</button>
          <button className="secondary-button" disabled={!selectedNodeId} onClick={() => setShowSelectedBranchOnly(true)} type="button">Fase actual</button>
          <select aria-label="Historial de fases" onChange={(event) => event.target.value && rememberNode(event.target.value)} value="">
            <option value="">Ultimas fases</option>
            {history.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
          </select>
        </div>
      </div>

      {validation.errors.length + validation.warnings.length > 0 ? (
        <div className="validation-box">
          <strong>{validation.errors.length} errores</strong>
          <strong>{validation.warnings.length} advertencias</strong>
          {validation.errors.map((error) => <p key={error} className="error-text">{error}</p>)}
          {validation.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}

      <div className="tree-layout">
        <aside
          className="tree-panel"
          onDragOver={(event: DragEvent) => event.preventDefault()}
          onDrop={() => handleDrop('')}
        >
          {document.nodes.length === 0 ? (
            <p className="empty-state">Anade un nodo raiz para empezar el arbol.</p>
          ) : (
            <ul className="tree-list root-list">{document.nodes.map((node) => renderNode(node))}</ul>
          )}
        </aside>

        <form className="node-form no-print">
          {selectedNode ? (
            <>
              <label>ID<input onChange={(event) => handleSelectedNodeChange('id', event.target.value)} value={selectedNode.id} /></label>
              <label>Titulo<input onChange={(event) => handleSelectedNodeChange('title', event.target.value)} value={selectedNode.title} /></label>
              <label>Estado<select onChange={(event) => handleSelectedNodeChange('status', event.target.value as RoadmapNodeStatus)} value={selectedNode.status}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label>Objetivo<textarea onChange={(event) => handleSelectedNodeChange('objective', event.target.value)} value={selectedNode.objective} /></label>
              <label>Descripcion<textarea onChange={(event) => handleSelectedNodeChange('description', event.target.value)} value={selectedNode.description} /></label>
              <label>Resultado esperado<textarea onChange={(event) => handleSelectedNodeChange('expectedResult', event.target.value)} value={selectedNode.expectedResult} /></label>
              <label>Dentro de alcance<textarea onChange={(event) => handleSelectedNodeChange('inScope', linesToList(event.target.value))} value={listToLines(selectedNode.inScope)} /></label>
              <label>Fuera de alcance<textarea onChange={(event) => handleSelectedNodeChange('outOfScope', linesToList(event.target.value))} value={listToLines(selectedNode.outOfScope)} /></label>
              <label>Dependencias<textarea onChange={(event) => handleSelectedNodeChange('dependencies', linesToList(event.target.value))} value={listToLines(selectedNode.dependencies)} /></label>
              <label>Documentos<textarea onChange={(event) => handleSelectedNodeChange('documents', linesToDocuments(event.target.value))} value={documentsToLines(selectedNode.documents)} placeholder="Titulo | ruta-o-url" /></label>
              <label>Commits<textarea onChange={(event) => handleSelectedNodeChange('commits', linesToList(event.target.value))} value={listToLines(selectedNode.commits)} /></label>
              <label>Notas<textarea onChange={(event) => handleSelectedNodeChange('notes', event.target.value)} value={selectedNode.notes} /></label>
              <div className="move-controls">
                <label>Padre<select onChange={(event) => handleMove(event.target.value, selectedFlatNode?.index ?? 0)} value={currentParentId}><option value="">Raiz</option>{parentOptions.map(({ node }) => <option key={node.id} value={node.id}>{node.title || node.id}</option>)}</select></label>
                <label>Posicion<input min={0} max={Math.max(siblingCount - 1, 0)} onChange={(event) => handleMove(currentParentId, Number(event.target.value))} type="number" value={selectedFlatNode?.index ?? 0} /></label>
              </div>
              <label>Copiado<select aria-label="Menu de copiado" onChange={(event) => event.target.value && copyNodeAction(event.target.value)} value=""><option value="">Copiar...</option><option value="id">Copiar ID</option><option value="idTitle">Copiar ID y titulo</option><option value="phaseMarkdown">Copiar fase como Markdown</option><option value="branchMarkdown">Copiar fase y descendientes como Markdown</option><option value="phaseJson">Copiar fase como JSON</option><option value="branchJson">Copiar fase y descendientes como JSON</option><option value="path">Copiar ruta jerarquica</option><option value="codex">Copiar contexto para Codex</option><option value="codexAncestors">Copiar contexto para Codex con ancestros</option><option value="codexDescendants">Copiar contexto para Codex con descendientes</option><option value="codexComplete">Copiar contexto completo</option></select></label>
            </>
          ) : (
            <p className="empty-state">Selecciona un nodo para editarlo.</p>
          )}
        </form>
      </div>

      <section className="markdown-panel no-print">
        <div className="section-heading">
          <div><h2>Markdown y PDF</h2><p>Vista previa, descarga e impresion</p></div>
          <button onClick={openPrintView} type="button">Abrir vista PDF</button>
        </div>
        <div className="tree-actions">
          <button onClick={() => setMarkdownPreview(makeMarkdown('selected'))} type="button">Fase seleccionada</button>
          <button onClick={() => setMarkdownPreview(makeMarkdown('branch'))} type="button">Rama seleccionada</button>
          <button onClick={() => setMarkdownPreview(makeMarkdown('roadmap'))} type="button">Roadmap completo</button>
          <button onClick={() => setMarkdownPreview(makeMarkdown('visible'))} type="button">Nodos visibles</button>
          <button disabled={!markdownPreview} onClick={() => copyText(markdownPreview)} type="button">Copiar Markdown</button>
          <button disabled={!markdownPreview} onClick={() => downloadText(`${slugify(document.project.name)}.md`, markdownPreview, 'text/markdown')} type="button">Descargar .md</button>
        </div>
        <div className="filter-row">
          <label className="compact-label">PDF alcance<select onChange={(event) => setPrintOptions({ ...printOptions, scope: event.target.value as PrintOptions['scope'] })} value={printOptions.scope}><option value="selected">Fase seleccionada</option><option value="branch">Rama seleccionada</option><option value="roadmap">Roadmap completo</option><option value="filtered">Vista filtrada</option></select></label>
          <label className="compact-label">Modo<select onChange={(event) => setPrintOptions({ ...printOptions, mode: event.target.value as PrintMode })} value={printOptions.mode}><option value="hierarchy">Documento jerarquico</option><option value="tree">Arbol visual</option></select></label>
          <label className="compact-label">Profundidad PDF<input min={0} max={24} onChange={(event) => setPrintOptions({ ...printOptions, maxDepth: Number(event.target.value) })} type="number" value={printOptions.maxDepth} /></label>
          {(['includeDescription', 'includeNotes', 'includeDocuments', 'includeCommits', 'includeDependencies', 'includeStatuses'] as const).map((key) => (
            <label key={key} className="check-label"><input checked={printOptions[key]} onChange={(event) => setPrintOptions({ ...printOptions, [key]: event.target.checked })} type="checkbox" />{key.replace('include', '')}</label>
          ))}
        </div>
        <pre className="markdown-preview">{markdownPreview || printMarkdown}</pre>
      </section>

      <section className={`print-surface ${printOptions.mode}`}>
        <pre>{printMarkdown}</pre>
      </section>
    </section>
  )
}
