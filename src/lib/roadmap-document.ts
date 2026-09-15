import type {
  RoadmapDocument,
  RoadmapIdea,
  RoadmapNode,
  RoadmapNodeStatus,
} from '../types/roadmap'

/**
 * Modelo del roadmap, extraido de RoadmapEditor.tsx para que la aplicacion y
 * la API de lectura normalicen y serialicen con el mismo codigo. Todo lo de
 * aqui es logica de datos: no importa React y no toca el DOM al cargarse.
 *
 * La unica dependencia del navegador que queda es el saneado de ideas[], que
 * necesita parsear HTML de verdad. Se resuelve de forma perezosa contra
 * globalThis: en el navegador es window.DOMParser, y donde no hay DOM lanza
 * RichTextUnavailableError en vez de devolver un documento distinto.
 */

export class RichTextUnavailableError extends Error {
  constructor() {
    super(
      'No hay DOMParser en este entorno: el saneado de ideas[] necesita un DOM. ' +
        'Un documento sin ideas con contenido se normaliza sin tocar esta ruta.',
    )
    this.name = 'RichTextUnavailableError'
  }
}

type DomParserConstructor = new () => DOMParser

function resolveDomParser(): DomParserConstructor {
  const parser = (globalThis as { DOMParser?: DomParserConstructor }).DOMParser
  if (!parser) throw new RichTextUnavailableError()
  return parser
}

export const statusOptions: Array<{ label: string; value: RoadmapNodeStatus }> = [
  { label: 'Planificada', value: 'planned' },
  { label: 'Pendiente', value: 'pending' },
  { label: 'En curso', value: 'in_progress' },
  { label: 'Bloqueada', value: 'blocked' },
  { label: 'Cerrada', value: 'closed' },
]

const allowedStatuses = new Set(statusOptions.map(({ value }) => value))

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

export function statusLabel(status: RoadmapNodeStatus) {
  return statusOptions.find((option) => option.value === status)?.label ?? status
}

function normalizeStatus(value: unknown): RoadmapNodeStatus {
  if (value === 'done') return 'closed'
  if (allowedStatuses.has(value as RoadmapNodeStatus)) {
    return value as RoadmapNodeStatus
  }
  return 'planned'
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

export function applyAutomaticStatuses(nodes: RoadmapNode[]): RoadmapNode[] {
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

function makeUniqueNodeId(existingIds: Set<string>, value: string, fallback = 'fase') {
  const base = value.trim() || fallback
  let candidate = base
  let index = 2

  while (existingIds.has(candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }

  existingIds.add(candidate)
  return candidate
}

function ensureUniqueNodeIds(nodes: RoadmapNode[], existingIds = new Set<string>()): RoadmapNode[] {
  return nodes.map((node) => {
    const nextId = makeUniqueNodeId(existingIds, node.id)

    return {
      ...node,
      id: nextId,
      children: ensureUniqueNodeIds(node.children, existingIds),
    }
  })
}

export function sanitizeRichText(html: string) {
  if (!html.trim()) return ''
  const parsed = new (resolveDomParser())().parseFromString(html, 'text/html')
  parsed.body.querySelectorAll('*').forEach((element) => {
    if (!allowedRichTextTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      return
    }
    Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name))
  })
  return parsed.body.innerHTML.trim()
}

export function htmlToPlainText(html: string) {
  if (!html.trim()) return ''
  const parsed = new (resolveDomParser())().parseFromString(html, 'text/html')
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
    nodes: Array.isArray(document.nodes)
      ? applyAutomaticStatuses(ensureUniqueNodeIds(document.nodes.map(normalizeNode)))
      : [],
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

export function parseRoadmapImportJson(value: string, fallbackDocument: RoadmapDocument): {
  document: RoadmapDocument | null
  errors: string[]
} {
  try {
    const parsed = JSON.parse(value) as unknown
    const documentLike = parsed && typeof parsed === 'object' ? parsed as Partial<RoadmapDocument> : null
    const nodesSource =
      Array.isArray(parsed)
        ? parsed
        : Array.isArray(documentLike?.nodes)
          ? documentLike.nodes
          : documentLike && 'id' in documentLike
            ? [documentLike]
            : null

    if (!nodesSource) {
      return {
        document: null,
        errors: ['Pega un proyecto completo, un array de fases o una fase con children.'],
      }
    }

    const errors: string[] = []
    validateNodes(nodesSource, errors, new Set())
    if (errors.length > 0) return { document: null, errors }

    const project = documentLike?.project?.id && documentLike.project.name
      ? documentLike.project
      : fallbackDocument.project

    return {
      document: normalizeRoadmapDocument({
        schemaVersion: 1,
        project,
        ideas: Array.isArray(documentLike?.ideas) ? documentLike.ideas : fallbackDocument.ideas,
        nodes: nodesSource,
      }),
      errors: [],
    }
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
