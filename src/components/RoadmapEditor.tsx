import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react'
import type {
  RoadmapDocument,
  RoadmapNode,
  RoadmapNodeStatus,
  RoadmapProject,
} from '../types/roadmap'
import { Decisor } from './Decisor'
import { Icon } from './Icon'
import { contarDecisionesDelNodo, repuntarDecisionesDelNodo } from '../lib/decisiones-del-nodo'
import {
  applyAutomaticStatuses,
  normalizeRoadmapDocument,
  parseRoadmapImportJson,
  statusLabel,
  statusOptions,
  stringifyRoadmapJson,
} from '../lib/roadmap-document'

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

type RoadmapEditorProps = {
  availableProjects: RoadmapProject[]
  document: RoadmapDocument
  /** El uuid de la fila del proyecto. Lo necesita el decisor, que escribe en su propia tabla. */
  projectId: string
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
type EditorMode = 'editor' | 'canvas' | 'decisor'
type ProjectMergeMode = 'append-root' | 'append-to-selected'
type DropTarget =
  | { type: 'root' }
  | { type: 'child'; parentId: string }
  | { type: 'sibling'; parentId: string; index: number }

type CanvasNode = FlatNode & {
  x: number
  y: number
}

const canvasNodeWidth = 380
const canvasNodeHeight = 126
const canvasColumnGap = 470
const canvasRowGap = 158

const branchJsonExample = stringifyRoadmapJson({
  id: 'nueva-rama',
  title: 'Nueva rama',
  status: 'planned',
  content: 'Notas o markdown de esta fase.',
  children: [
    {
      id: 'nueva-rama-subfase',
      title: 'Primera subfase',
      status: 'planned',
      content: '',
      children: [],
    },
  ],
})

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

function createUniqueNodeId(existingIds: Set<string>, base = 'fase') {
  const randomPart = window.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  let candidate = `${base}-${Date.now().toString(36)}-${randomPart}`
  let index = 2

  while (existingIds.has(candidate)) {
    candidate = `${base}-${Date.now().toString(36)}-${randomPart}-${index}`
    index += 1
  }

  existingIds.add(candidate)
  return candidate
}

/** El titulo con el que nace una fase. Se compara con el para saber si sigue sin tocar. */
const tituloPorDefecto = 'Nueva fase'

/**
 * El id que se propone para una fase nueva: el siguiente de su rama.
 *
 * Los ids los escribe Ruben, y eso no cambia —esto es una propuesta, y llega
 * seleccionada para que teclear encima la borre—. Pero proponer
 * "fase-mugu6hn8-a1a30b68" era proponer nada: habia que vaciar veintidos
 * caracteres antes de poder escribir. Colgando de SP4.1 con SP4.1.1 y SP4.1.2
 * dentro, lo que casi siempre toca es SP4.1.3.
 *
 * Si la rama no sigue la convencion numerica, o es una fase raiz, no hay nada
 * sensato que proponer y se vuelve al id generado, que al menos es unico.
 */
function proponerIdDeRama(parentId: string, hermanos: RoadmapNode[], existingIds: Set<string>) {
  if (!parentId) return ''

  const prefijo = `${parentId}.`
  let ultimo = 0
  for (const hermano of hermanos) {
    if (!hermano.id.startsWith(prefijo)) continue
    const cola = hermano.id.slice(prefijo.length)
    if (!/^\d+$/.test(cola)) continue
    ultimo = Math.max(ultimo, Number(cola))
  }

  let candidato = `${prefijo}${ultimo + 1}`
  while (existingIds.has(candidato)) {
    ultimo += 1
    candidato = `${prefijo}${ultimo + 1}`
  }
  return candidato
}

function createNode(existingIds: Set<string>, idPropuesto = ''): RoadmapNode {
  const id = idPropuesto || createUniqueNodeId(existingIds)
  return {
    id,
    title: tituloPorDefecto,
    status: 'planned',
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

/** Lo que el filtro del arbol mira de una fase. En un sitio, porque lo usan tres. */
function casaConLaBusqueda(node: RoadmapNode, texto: string) {
  return [node.id, node.title, node.content].join(' ').toLowerCase().includes(texto)
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
    children: node.children,
  })
}

/**
 * Lo que escribe Ruben es texto, no HTML. Aqui se convierte en HTML pegando
 * cadenas, y lo que sale entra por dangerouslySetInnerHTML en la vista de
 * impresion, asi que el texto se escapa antes de tocar ninguna etiqueta.
 *
 * No es solo una defensa: un titulo con un signo de menor que ya rompia el
 * HTML de la impresion sin que nadie atacara nada. Y el contenido de un nodo
 * no siempre lo ha escrito Ruben —entra tambien por las cuatro importaciones
 * de JSON—, de modo que aqui hay que tratarlo como texto de fuera.
 */
function escaparHtml(texto: string) {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function markdownToHtml(markdown: string) {
  return markdown
    .split('\n')
    .map((linea) => {
      // Se escapa la linea entera antes de mirarla. El escape no toca ni las
      // almohadillas, ni el guion de la lista, ni los asteriscos, asi que las
      // tres reglas de abajo siguen viendo lo mismo que veian.
      const line = escaparHtml(linea)
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
  if (syncStatus === 'syncing') return 'Guardando'
  if (syncStatus === 'synced') return 'Guardado'
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
  projectId,
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
  const [idDraft, setIdDraft] = useState('')
  const idInputRef = useRef<HTMLInputElement>(null)
  /** El ultimo focusIdNonce ya atendido, para no reseleccionar en cada tecla. */
  const nonceAtendido = useRef(0)
  const nodeRefs = useRef<Record<string, HTMLLIElement | null>>({})

  /**
   * El renombrado pendiente de contestar: la fase, el id nuevo y cuantas
   * decisiones citan el viejo. Mientras esto no es null hay un modal delante y
   * no se ha tocado nada todavia.
   */
  const [renombrado, setRenombrado] = useState<{
    idViejo: string
    idNuevo: string
    decisiones: number
  } | null>(null)

  /**
   * La ultima busqueda que movio la seleccion. Sin esto, el efecto que
   * autoselecciona la primera coincidencia se volvia a disparar cada vez que
   * cambiaba el documento —al crear una fase, por ejemplo— y devolvia la
   * seleccion a la coincidencia de la busqueda, quitandosela a la fase recien
   * creada. Con el filtro puesto, eso dejaba el foco en el campo ID del padre.
   */
  const ultimaBusquedaAplicada = useRef('')

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
  const buscando = query.trim().length > 0
  const visibleIds = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return new Set(flatNodes.map(({ node }) => node.id))
    const ids = new Set<string>()
    flatNodes
      .filter(({ node }) => casaConLaBusqueda(node, text))
      .forEach(({ path }) => path.forEach((node) => ids.add(node.id)))
    return ids
  }, [flatNodes, query])
  /**
   * Cuantas fases casan de verdad, sin contar las que solo estan ahi por ser
   * madres de una que casa. Es el numero que contesta "¿estan todas?", que es
   * justo lo que el arbol no decia: el decisor lleva su "N a la vista" desde el
   * principio y el arbol no tenia nada.
   */
  const coincidencias = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return null
    return flatNodes.filter(({ node }) => casaConLaBusqueda(node, text)).length
  }, [flatNodes, query])
  const navigationNodes = useMemo(() => {
    return flatNodes.filter(({ node, path }) => {
      if (!visibleIds.has(node.id)) return false
      if (buscando) return true
      return path.slice(0, -1).every((ancestor) => expandedIds.has(ancestor.id))
    })
  }, [buscando, expandedIds, flatNodes, visibleIds])
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
    setIdDraft(selectedNode?.id ?? '')
  }, [selectedNode?.id])

  /**
   * Al crear una fase, el campo ID se enfoca con su contenido seleccionado.
   *
   * select() y no focus(): el id llega propuesto —el siguiente de la rama— y
   * con el cursor al final habia que vaciarlo a mano antes de escribir otro.
   *
   * Espera a que el borrador se haya puesto al dia con la fase nueva. Antes se
   * seleccionaba en cuanto subia el contador, que es un render antes de que el
   * campo tenga el valor nuevo, y la seleccion se perdia al llegar este.
   */
  useEffect(() => {
    if (focusIdNonce === 0 || nonceAtendido.current === focusIdNonce) return
    if (idDraft !== (selectedNode?.id ?? '')) return
    nonceAtendido.current = focusIdNonce
    idInputRef.current?.select()
  }, [focusIdNonce, idDraft, selectedNode?.id])

  function emitNodes(nodes: RoadmapNode[]) {
    onChange({ ...document, nodes: applyAutomaticStatuses(nodes) })
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
    const existentes = collectNodeIds(document.nodes)
    const hermanos = parentId ? (findNode(document.nodes, parentId)?.children ?? []) : document.nodes
    const node = createNode(existentes, proponerIdDeRama(parentId, hermanos, existentes))
    // El filtro se quita al crear. Una fase nueva no casa con lo que hubiera
    // tecleado, asi que con el filtro puesto nacia invisible: no se veia, no
    // parecia que hubiera pasado nada, y se pulsaba otra vez.
    setQuery('')
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
    let nextValue = value

    if (key === 'id') {
      const nextId = String(value).trim()
      const duplicateId = nextId && collectNodeIds(document.nodes, new Set([previousId])).has(nextId)
      if (!nextId || duplicateId) {
        setErrorMessage(duplicateId ? `Ya existe una fase con el ID "${nextId}".` : 'El ID de la fase no puede quedarse vacio.')
        return
      }
      setErrorMessage('')
      nextValue = nextId as RoadmapNode[K]
    }

    emitNodes(updateNode(document.nodes, previousId, (node) => ({ ...node, [key]: nextValue })))
    if (key === 'id') setSelectedId(String(nextValue))
  }

  /**
   * Renombrar una fase pide un gesto explicito: Enter, o el boton de al lado.
   *
   * Antes bastaba con salir del campo, y eso convertia cualquier despiste en un
   * renombrado. El id de una fase es su nombre publico —sale en los informes,
   * en el conector y en las decisiones que la citan—, asi que no puede cambiar
   * porque alguien haya hecho clic en otro sitio. Salir del campo ahora
   * descarta lo tecleado, que es lo que hace el resto del mundo con un campo
   * que necesita confirmacion.
   */
  async function commitSelectedId() {
    if (!selectedNode) return
    const previousId = selectedNode.id
    const nextId = idDraft.trim()
    const duplicateId = nextId && collectNodeIds(document.nodes, new Set([previousId])).has(nextId)

    if (!nextId || duplicateId) {
      setErrorMessage(duplicateId ? `Ya existe una fase con el ID "${nextId}".` : 'El ID de la fase no puede quedarse vacio.')
      return
    }

    setErrorMessage('')
    if (nextId === previousId) return

    // Si hay decisiones que citan la fase por su id viejo, se pregunta antes de
    // tocar nada: el renombrado y el repunte se deciden juntos.
    const decisiones = await contarDecisionesDelNodo(projectId, previousId)
    if (decisiones > 0) {
      setRenombrado({ idViejo: previousId, idNuevo: nextId, decisiones })
      return
    }

    aplicarRenombrado(previousId, nextId)
  }

  function aplicarRenombrado(previousId: string, nextId: string) {
    emitNodes(updateNode(document.nodes, previousId, (node) => ({ ...node, id: nextId })))
    setIdDraft(nextId)
    setSelectedId(nextId)
  }

  /** Renombra y, si Ruben lo pide, lleva las decisiones a la fase nueva. */
  async function resolverRenombrado(repuntar: boolean) {
    if (!renombrado) return
    const { idViejo, idNuevo } = renombrado
    setRenombrado(null)
    aplicarRenombrado(idViejo, idNuevo)

    if (!repuntar) return
    const error = await repuntarDecisionesDelNodo(projectId, idViejo, idNuevo)
    if (error) setErrorMessage(`La fase se renombro, pero las decisiones no: ${error}`)
  }

  function cancelarRenombrado() {
    setIdDraft(renombrado?.idViejo ?? selectedNode?.id ?? '')
    setRenombrado(null)
  }

  /** Lo tecleado en el ID todavia no es el id de nada. */
  const idSinConfirmar = Boolean(selectedNode) && idDraft.trim() !== selectedNode?.id

  function descartarIdDraft() {
    setIdDraft(selectedNode?.id ?? '')
    setErrorMessage('')
  }

  function handleIdKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitSelectedId()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      descartarIdDraft()
      event.currentTarget.blur()
    }
  }

  function handleContentKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || !selectedNode) return

    event.preventDefault()
    const editor = event.currentTarget
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const nextContent = `${editor.value.slice(0, start)}\n${editor.value.slice(end)}`
    const nextCursor = start + 1

    updateSelected('content', nextContent)
    window.requestAnimationFrame(() => {
      editor.setSelectionRange(nextCursor, nextCursor)
    })
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
    const automaticNodes = applyAutomaticStatuses(updateNode(document.nodes, selectedNode.id, () => nextNode))
    onChange({
      ...document,
      nodes: updateNode(automaticNodes, selectedNode.id, (node) => ({ ...node, status: 'in_progress' })),
    })
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
    const result = parseRoadmapImportJson(importText, document)
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
    if (!text) {
      ultimaBusquedaAplicada.current = ''
      return
    }
    // Solo cuando cambia lo tecleado. El efecto depende tambien de flatNodes
    // porque necesita el arbol para buscar, pero un cambio del documento no es
    // una busqueda nueva y no debe mover la seleccion.
    if (ultimaBusquedaAplicada.current === text) return
    const match = flatNodes.find(({ node }) =>
      [node.id, node.title, node.content].join(' ').toLowerCase().includes(text),
    )
    if (!match) return
    ultimaBusquedaAplicada.current = text
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
  // Lo que se imprime es el roadmap. Las decisiones no entran aqui: se leen
  // en su pantalla y se exportan a su fichero.
  const printHtml = markdownToHtml(printMarkdown)

  function renderNode(node: RoadmapNode, depth = 0, parentId = '', index = 0) {
    if (!visibleIds.has(node.id)) return null
    /**
     * Mientras se busca, una coincidencia se ve aunque su madre este plegada.
     * Antes no: el arbol solo pintaba hijos de lo expandido y el efecto de
     * busqueda solo abria la rama de la primera coincidencia, asi que buscar
     * "SP4.1" ensenaba tres filas de cinco que casaban y no habia forma de
     * saber que faltaban dos. El lienzo de Esquema ya lo hacia bien.
     */
    const hijosVisibles = node.children.filter((child) => visibleIds.has(child.id))
    const abiertoPorLaBusqueda = buscando && hijosVisibles.length > 0
    const expanded = expandedIds.has(node.id) || abiertoPorLaBusqueda
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
          <button
            className="tree-toggle"
            disabled={node.children.length === 0 || abiertoPorLaBusqueda}
            onClick={() => toggleNodeExpansion(node)}
            aria-label={expanded ? 'Contraer fase' : 'Expandir fase'}
            title={abiertoPorLaBusqueda ? 'Mientras buscas se ven todas las coincidencias' : expanded ? 'Contraer' : 'Expandir'}
            type="button"
          >
            {node.children.length === 0 ? null : <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />}
          </button>
          {/* El title lleva el id, el titulo y el estado. En el arbol de Songplay
              98 de 143 titulos salen cortados a lo ancho por defecto, y sin esto
              no habia forma de leer el que se cortaba sin seleccionar la fase.
              El estado va aqui tambien porque el punto es lo unico que lo dice y
              es un circulo de ocho pixeles sin leyenda en ninguna pantalla. */}
          <button
            className="file-name"
            onClick={() => selectNode(node)}
            title={`${node.id || 'sin-id'} — ${node.title || tituloPorDefecto} · ${statusLabel(node.status)}`}
            type="button"
          >
            <span className={`state-dot ${node.status}`} title={statusLabel(node.status)} />
            <strong>{node.id || 'sin-id'}</strong>
            <span>{node.title || tituloPorDefecto}</span>
          </button>
          <span className="progress-chip" title={`${progress}% completado`}>{progress}%</span>
          <button aria-label="Copiar fase" className="copy-button" onClick={() => copyText(nodeMarkdown(node))} title="Copiar fase" type="button">
            <Icon name="copy" />
          </button>
          {/* Abrir el menu selecciona la fila. Antes no, y habia dos nociones de
              "fase actual" a la vez: se podia estar editando SP4.1 en el panel
              de la derecha y borrar SP4.3 desde su menu tres filas mas abajo,
              con el panel ensenando todavia SP4.1. */}
          <button
            aria-label="Mas acciones"
            className="menu-button"
            onClick={() => {
              if (openMenuId !== node.id) selectNode(node)
              setOpenMenuId(openMenuId === node.id ? null : node.id)
            }}
            title="Mas acciones"
            type="button"
          >
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
        {/* Se recorren todos los hijos, no solo los visibles, para que el indice
            que reciben siga siendo el de verdad: "Hermana" inserta en index + 1. */}
        {expanded && (buscando ? hijosVisibles.length > 0 : node.children.length > 0) ? (
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

  // Lo del arbol solo se ve con el arbol delante. Un boton que exporta una
  // rama o imprime el roadmap, con las decisiones abiertas, no es un boton de
  // mas: es un boton que dice que hace otra cosa de la que hace.
  const enElArbol = editorMode !== 'decisor'

  return (
    <main className="roadmap-screen">
      <header className="roadmap-bar no-print">
        <div className="roadmap-title">
          <img src="/arboria-logo.png" alt="" />
          {enElArbol ? (
            <input
              aria-label="Nombre del proyecto"
              onChange={(event) => onChange({ ...document, project: { ...document.project, name: event.target.value } })}
              value={document.project.name}
            />
          ) : (
            // El nombre se lee en las tres vistas, pero se escribe donde se
            // escribe el documento del roadmap, que es donde vive.
            <strong className="roadmap-title-fijo">{document.project.name}</strong>
          )}
        </div>
        {enElArbol ? (
          // El numero va al lado de la barra y no encima. Encima iba en blanco
          // sobre la pastilla, asi que por debajo del 100% la mitad del numero
          // caia sobre el fondo claro y no se leia.
          <span className="project-progress" title={`${projectProgress}% completado`}>
            <span className="project-progress-track" aria-hidden="true">
              <span style={{ width: `${projectProgress}%` }} />
            </span>
            <strong>{projectProgress}%</strong>
          </span>
        ) : null}
        <div className="mode-switch" role="group" aria-label="Vista del editor">
          <button className={editorMode === 'editor' ? 'active' : ''} onClick={() => setEditorMode('editor')} type="button"><Icon name="fileBranch" /> Editar</button>
          <button className={editorMode === 'canvas' ? 'active' : ''} onClick={() => setEditorMode('canvas')} type="button"><Icon name="gitMerge" /> Esquema</button>
          <button className={editorMode === 'decisor' ? 'active' : ''} onClick={() => setEditorMode('decisor')} type="button"><Icon name="check" /> Decisiones</button>
        </div>
        {enElArbol ? (
          <>
            <span className={`sync-state ${syncStatus}`} title={syncError || syncLabel(syncStatus)}>{syncLabel(syncStatus)}</span>
            <div className="toolbar-group">
              <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
              <button className="secondary-button" onClick={() => openImport('replace-project')} title="Importar JSON" type="button"><Icon name="upload" /> Importar JSON</button>
              <button aria-label="Exportar proyecto" className="icon-only secondary-button" onClick={exportProject} title="Exportar proyecto" type="button"><Icon name="download" /></button>
              <button aria-label="Exportar rama" className="icon-only secondary-button" onClick={exportBranch} title="Exportar rama" type="button"><Icon name="fileBranch" /></button>
              <button aria-label="Imprimir" className="icon-only secondary-button" onClick={() => setShowPrint(true)} title="Imprimir" type="button"><Icon name="printer" /></button>
            </div>
          </>
        ) : null}
        <div className="toolbar-group">
          {/* Volver lleva flecha atras y no una carpeta abierta: la carpeta decia
              "abrir algo" justo en el boton que cierra el proyecto. */}
          <button aria-label="Volver a proyectos" className="icon-only secondary-button" onClick={onBack} title="Volver a proyectos" type="button"><Icon name="arrowLeft" /></button>
          {/* Separado del anterior a proposito: uno sale del proyecto y el otro
              de la cuenta, y estaban pegados con dos iconos de flecha. */}
          <span className="barra-separador" aria-hidden="true" />
          <button aria-label="Cerrar sesion" className="icon-only secondary-button" onClick={onSignOut} title="Cerrar sesion" type="button"><Icon name="logOut" /></button>
        </div>
      </header>

      {errorMessage && enElArbol ? <p className="form-error no-print">{errorMessage}</p> : null}

      {editorMode === 'canvas' ? (
        <section className="branch-canvas-panel full-screen no-print" aria-label="Editor visual de ramas">
            <div className="canvas-toolbar">
              <button className="secondary-button" onClick={() => setEditorMode('editor')} type="button"><Icon name="arrowLeft" /> Editar</button>
              <input aria-label="Buscar fases" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar fases" type="search" value={query} />
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
      ) : editorMode === 'decisor' ? (
        <Decisor
          fasesDelRoadmap={flatNodes.map(({ node }) => node.id)}
          projectId={projectId}
          proyecto={document.project}
        />
      ) : (
        <section className="roadmap-body">
          <aside className="file-tree no-print">
            {/* Cabecera del arbol: los botones y, cuando se busca, el recuento.
                Van juntos en un solo hijo porque .file-tree son dos filas y la
                de abajo es la que hace scroll. */}
            <div className="tree-head">
            <div className="tree-mini-actions">
              <button onClick={() => addNode('')} title="Añadir fase raiz" type="button"><Icon name="plus" /> Raiz</button>
              <input aria-label="Buscar fases" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar fases" type="search" value={query} />
              <button aria-label="Expandir todo" className="icon-only secondary-button" onClick={() => setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))} title="Expandir todo" type="button"><Icon name="maximize" /></button>
              <button aria-label="Contraer todo" className="icon-only secondary-button" onClick={() => setExpandedIds(new Set())} title="Contraer todo" type="button"><Icon name="minimize" /></button>
              <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
            </div>
            {coincidencias !== null ? (
              <p className="tree-matches" role="status">
                {coincidencias === 0
                  ? 'Ninguna coincidencia'
                  : `${coincidencias} ${coincidencias === 1 ? 'coincidencia' : 'coincidencias'} de ${flatNodes.length} fases`}
              </p>
            ) : null}
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
                <button className="secondary-button" onClick={() => openImport('append-to-selected')} title="Importar como subfases" type="button"><Icon name="upload" /> Importar debajo</button>
                <button className="secondary-button" onClick={() => openImport('replace-selected')} title="Reemplazar esta rama" type="button"><Icon name="import" /> Reemplazar rama</button>
                <button aria-label="Unir otro proyecto" className="icon-only secondary-button" disabled={availableProjects.length === 0} onClick={openProjectMerge} title="Unir otro proyecto" type="button"><Icon name="gitMerge" /></button>
                {/* Bandera y no check: esto no acepta nada, pone la fase en cerrada y
                    escribe en el documento. El check queda para confirmar. */}
                <button aria-label="Cerrar fase" className="icon-only secondary-button" disabled={selectedNode.status === 'closed'} onClick={() => closeNode(selectedNode)} title="Cerrar fase (la pone en cerrada)" type="button"><Icon name="flag" /></button>
                <button className="secondary-button" onClick={copySelectedJson} title="Copiar rama JSON" type="button"><Icon name="copy" /> Copiar JSON</button>
              </div>
              <div className="editor-fields no-print">
                <label>
                  ID
                  <input
                    ref={idInputRef}
                    onBlur={descartarIdDraft}
                    onChange={(event) => setIdDraft(event.target.value)}
                    onKeyDown={handleIdKeyDown}
                    value={idDraft}
                  />
                  {idSinConfirmar ? (
                    <span className="id-pendiente">
                      {/* En onMouseDown, porque el onBlur del campo descarta lo
                          tecleado y con onClick llegaria despues. */}
                      <button
                        className="id-confirm"
                        onMouseDown={(event) => {
                          event.preventDefault()
                          commitSelectedId()
                        }}
                        title={`Renombrar la fase a "${idDraft.trim()}"`}
                        type="button"
                      >
                        <Icon name="check" /> Renombrar
                      </button>
                      <span className="id-hint">Enter tambien. Salir del campo lo descarta.</span>
                    </span>
                  ) : null}
                </label>
                <label>
                  Título
                  {/* Mientras siga siendo el titulo con el que nacio, entrar en el
                      campo lo selecciona: teclear lo reemplaza en vez de anadirse
                      detras y dejar "Nueva faseRecorte de frontera". */}
                  <input
                    onChange={(event) => updateSelected('title', event.target.value)}
                    onFocus={(event) => {
                      if (event.target.value === tituloPorDefecto) event.target.select()
                    }}
                    value={selectedNode.title}
                  />
                </label>
                <label>Estado<select onChange={(event) => updateSelected('status', event.target.value as RoadmapNodeStatus)} value={selectedNode.status}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <textarea
                aria-label="Contenido"
                className="content-editor"
                onChange={(event) => updateSelected('content', event.target.value)}
                onKeyDown={handleContentKeyDown}
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

      {renombrado ? (
        <div className="modal-backdrop no-print">
          <section className="modal">
            <h2>Renombrar {renombrado.idViejo} a {renombrado.idNuevo}</h2>
            <p className="modal-hint">
              {renombrado.decisiones === 1
                ? 'Hay 1 decision que cita esta fase por su ID.'
                : `Hay ${renombrado.decisiones} decisiones que citan esta fase por su ID.`}{' '}
              El decisor guarda la fase como texto, asi que si no se cambian ahora
              se quedaran apuntando a <code>{renombrado.idViejo}</code>, que ya no
              existira.
            </p>
            <div className="modal-actions">
              <button onClick={() => resolverRenombrado(true)} type="button">
                <Icon name="check" /> Renombrar y llevarme {renombrado.decisiones === 1 ? 'la decision' : `las ${renombrado.decisiones}`}
              </button>
              <button className="secondary-button" onClick={() => resolverRenombrado(false)} type="button">
                Renombrar y dejarlas como estan
              </button>
              <button className="secondary-button" onClick={cancelarRenombrado} type="button">
                Cancelar
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showImport ? (
        <div className="modal-backdrop no-print">
          <section className="modal">
            <h2>Importar JSON</h2>
            <p className="modal-hint">
              Para crear ramas con JSON, pega una fase con <code>children</code>. Tambien puedes pegar un array de fases o un proyecto completo.
            </p>
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
            <details className="json-example">
              <summary>Ver ejemplo de rama JSON</summary>
              <pre>{branchJsonExample}</pre>
              <button className="secondary-button" onClick={() => setImportText(branchJsonExample)} type="button"><Icon name="copy" /> Usar ejemplo</button>
            </details>
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

      {/* Imprimir desde el navegador con las decisiones delante sacaba el
          roadmap, porque esta superficie es lo unico que no lleva no-print. */}
      {enElArbol ? (
        <section className="print-surface" dangerouslySetInnerHTML={{ __html: printHtml }} />
      ) : null}
    </main>
  )
}
