import { useEffect, useMemo, useState } from 'react'
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
  onChange: (document: RoadmapDocument) => void
}

type FlatNode = {
  node: RoadmapNode
  parentId: string
  depth: number
  index: number
}

const statusOptions: Array<{ label: string; value: RoadmapNodeStatus }> = [
  { label: 'Pendiente', value: 'pending' },
  { label: 'En curso', value: 'in_progress' },
  { label: 'Hecho', value: 'done' },
  { label: 'Bloqueado', value: 'blocked' },
]

function createNode(seed: string): RoadmapNode {
  return {
    id: seed,
    title: 'Nuevo nodo',
    status: 'pending',
    goal: '',
    expectedOutcome: '',
    children: [],
  }
}

function walkNodes(
  nodes: RoadmapNode[],
  callback: (node: RoadmapNode, parentId: string, depth: number, index: number) => void,
  parentId = '',
  depth = 0,
) {
  nodes.forEach((node, index) => {
    callback(node, parentId, depth, index)
    walkNodes(node.children, callback, node.id, depth + 1)
  })
}

function flattenNodes(nodes: RoadmapNode[]) {
  const flatNodes: FlatNode[] = []
  walkNodes(nodes, (node, parentId, depth, index) => {
    flatNodes.push({ node, parentId, depth, index })
  })
  return flatNodes
}

function findNode(nodes: RoadmapNode[], nodeId: string): RoadmapNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node
    }

    const childNode = findNode(node.children, nodeId)
    if (childNode) {
      return childNode
    }
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
    if (node.id === nodeId) {
      return updater(node)
    }

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
    return {
      ...node,
      children: nextChildren,
    }
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

function syncLabel(syncStatus: SyncStatus) {
  if (syncStatus === 'local') return 'Guardado localmente'
  if (syncStatus === 'syncing') return 'Sincronizando'
  if (syncStatus === 'synced') return 'Sincronizado'
  return 'Error'
}

export function RoadmapEditor({
  document,
  onChange,
  syncError,
  syncStatus,
}: RoadmapEditorProps) {
  const flatNodes = useMemo(() => flattenNodes(document.nodes), [document.nodes])
  const [selectedNodeId, setSelectedNodeId] = useState(flatNodes[0]?.node.id ?? '')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(flatNodes.map(({ node }) => node.id)),
  )
  const [query, setQuery] = useState('')
  const selectedNode = selectedNodeId ? findNode(document.nodes, selectedNodeId) : null
  const selectedFlatNode = flatNodes.find(({ node }) => node.id === selectedNodeId)
  const visibleNodeIds = useMemo(() => {
    if (!query.trim()) {
      return new Set(flatNodes.map(({ node }) => node.id))
    }

    const normalizedQuery = query.trim().toLowerCase()
    return new Set(
      flatNodes
        .filter(({ node }) => {
          return (
            node.id.toLowerCase().includes(normalizedQuery) ||
            node.title.toLowerCase().includes(normalizedQuery)
          )
        })
        .map(({ node }) => node.id),
    )
  }, [flatNodes, query])

  useEffect(() => {
    if (!selectedNode && flatNodes[0]) {
      setSelectedNodeId(flatNodes[0].node.id)
    }
  }, [flatNodes, selectedNode])

  function emitNodes(nodes: RoadmapNode[]) {
    onChange({
      ...document,
      nodes,
    })
  }

  function handleProjectNameChange(name: string) {
    onChange({
      ...document,
      project: {
        ...document.project,
        name,
      },
    })
  }

  function createUniqueNode(prefix = 'nodo') {
    const existingIds = new Set(flatNodes.map(({ node }) => node.id))
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
    setSelectedNodeId(nextNode.id)
  }

  function handleAddChild() {
    if (!selectedNode) return
    const nextNode = createUniqueNode(`${selectedNode.id}-hijo`)
    emitNodes(insertNode(document.nodes, selectedNode.id, nextNode))
    setExpandedIds((currentIds) => new Set([...currentIds, selectedNode.id]))
    setSelectedNodeId(nextNode.id)
  }

  function handleAddSibling() {
    if (!selectedFlatNode) {
      handleAddRoot()
      return
    }

    const nextNode = createUniqueNode(`${selectedFlatNode.node.id}-hermano`)
    emitNodes(
      insertNode(
        document.nodes,
        selectedFlatNode.parentId,
        nextNode,
        selectedFlatNode.index + 1,
      ),
    )
    setSelectedNodeId(nextNode.id)
  }

  function handleDuplicate() {
    if (!selectedNode || !selectedFlatNode) return
    const duplicatedNode = cloneNode(selectedNode, Date.now().toString(36))
    emitNodes(
      insertNode(
        removeNode(document.nodes, duplicatedNode.id),
        selectedFlatNode.parentId,
        duplicatedNode,
        selectedFlatNode.index + 1,
      ),
    )
    setSelectedNodeId(duplicatedNode.id)
  }

  function handleDelete() {
    if (!selectedNode) return
    const confirmed = window.confirm(`Eliminar "${selectedNode.title}" y sus hijos?`)
    if (!confirmed) return

    emitNodes(removeNode(document.nodes, selectedNode.id))
    setSelectedNodeId('')
  }

  function handleSelectedNodeChange<K extends keyof RoadmapNode>(
    key: K,
    value: RoadmapNode[K],
  ) {
    if (!selectedNode) return
    emitNodes(
      updateNode(document.nodes, selectedNode.id, (node) => ({
        ...node,
        [key]: value,
      })),
    )

    if (key === 'id') {
      setSelectedNodeId(String(value))
    }
  }

  function handleMove(parentId: string, position: number) {
    if (!selectedNode || !selectedFlatNode) return
    if (parentId === selectedNode.id || containsNode(selectedNode, parentId)) return

    const nodesWithoutSelected = removeNode(document.nodes, selectedNode.id)
    const nextPosition =
      selectedFlatNode.parentId === parentId && selectedFlatNode.index < position
        ? position - 1
        : position

    emitNodes(insertNode(nodesWithoutSelected, parentId, selectedNode, nextPosition))
  }

  function toggleExpanded(nodeId: string) {
    setExpandedIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(nodeId)) {
        nextIds.delete(nodeId)
      } else {
        nextIds.add(nodeId)
      }
      return nextIds
    })
  }

  function expandAll() {
    setExpandedIds(new Set(flatNodes.map(({ node }) => node.id)))
  }

  function collapseAll() {
    setExpandedIds(new Set())
  }

  function renderNode(node: RoadmapNode, depth = 0) {
    if (!visibleNodeIds.has(node.id) && query.trim()) {
      const childMatches = node.children.some((child) => getBranchIds(child).some((id) => visibleNodeIds.has(id)))
      if (!childMatches) return null
    }

    const isExpanded = expandedIds.has(node.id)

    return (
      <li key={node.id}>
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
          <button
            className="tree-node-main"
            onClick={() => setSelectedNodeId(node.id)}
            type="button"
          >
            <strong>{node.title}</strong>
            <span>{node.id}</span>
          </button>
          <span className={`status-pill ${node.status}`}>
            {statusOptions.find((option) => option.value === node.status)?.label}
          </span>
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
    currentParentId === ''
      ? document.nodes.length
      : findNode(document.nodes, currentParentId)?.children.length ?? 0

  return (
    <section className="roadmap-editor">
      <div className="editor-toolbar">
        <div>
          <p className="eyebrow">Arbol</p>
          <input
            aria-label="Nombre del proyecto"
            className="project-title-input"
            onChange={(event) => handleProjectNameChange(event.target.value)}
            value={document.project.name}
          />
        </div>
        <div className={`sync-state ${syncStatus}`}>
          {syncLabel(syncStatus)}
          {syncError ? <span>{syncError}</span> : null}
        </div>
      </div>

      <div className="tree-actions">
        <button onClick={handleAddRoot} type="button">
          Anadir raiz
        </button>
        <button disabled={!selectedNode} onClick={handleAddChild} type="button">
          Anadir hijo
        </button>
        <button onClick={handleAddSibling} type="button">
          Anadir hermano
        </button>
        <button disabled={!selectedNode} onClick={handleDuplicate} type="button">
          Duplicar
        </button>
        <button
          className="text-danger"
          disabled={!selectedNode}
          onClick={handleDelete}
          type="button"
        >
          Eliminar
        </button>
      </div>

      <div className="tree-layout">
        <aside className="tree-panel">
          <div className="tree-filter">
            <input
              aria-label="Buscar por ID o titulo"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por ID o titulo"
              type="search"
              value={query}
            />
            <div>
              <button className="secondary-button" onClick={expandAll} type="button">
                Expandir
              </button>
              <button className="secondary-button" onClick={collapseAll} type="button">
                Contraer
              </button>
            </div>
          </div>
          {document.nodes.length === 0 ? (
            <p className="empty-state">Anade un nodo raiz para empezar el arbol.</p>
          ) : (
            <ul className="tree-list root-list">{document.nodes.map((node) => renderNode(node))}</ul>
          )}
        </aside>

        <form className="node-form">
          {selectedNode ? (
            <>
              <label>
                ID
                <input
                  onChange={(event) =>
                    handleSelectedNodeChange('id', event.target.value)
                  }
                  value={selectedNode.id}
                />
              </label>
              <label>
                Titulo
                <input
                  onChange={(event) =>
                    handleSelectedNodeChange('title', event.target.value)
                  }
                  value={selectedNode.title}
                />
              </label>
              <label>
                Estado
                <select
                  onChange={(event) =>
                    handleSelectedNodeChange(
                      'status',
                      event.target.value as RoadmapNodeStatus,
                    )
                  }
                  value={selectedNode.status}
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Objetivo
                <textarea
                  onChange={(event) =>
                    handleSelectedNodeChange('goal', event.target.value)
                  }
                  value={selectedNode.goal}
                />
              </label>
              <label>
                Resultado esperado
                <textarea
                  onChange={(event) =>
                    handleSelectedNodeChange('expectedOutcome', event.target.value)
                  }
                  value={selectedNode.expectedOutcome}
                />
              </label>
              <div className="move-controls">
                <label>
                  Padre
                  <select
                    onChange={(event) =>
                      handleMove(event.target.value, selectedFlatNode?.index ?? 0)
                    }
                    value={currentParentId}
                  >
                    <option value="">Raiz</option>
                    {parentOptions.map(({ node }) => (
                      <option key={node.id} value={node.id}>
                        {node.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Posicion
                  <input
                    min={0}
                    onChange={(event) =>
                      handleMove(currentParentId, Number(event.target.value))
                    }
                    type="number"
                    value={selectedFlatNode?.index ?? 0}
                    max={Math.max(siblingCount - 1, 0)}
                  />
                </label>
              </div>
            </>
          ) : (
            <p className="empty-state">Selecciona un nodo para editarlo.</p>
          )}
        </form>
      </div>
    </section>
  )
}
