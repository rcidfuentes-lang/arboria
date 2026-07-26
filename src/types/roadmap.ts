export type RoadmapDocument = {
  schemaVersion: 1
  project: {
    id: string
    name: string
  }
  ideas: RoadmapIdea[]
  nodes: RoadmapNode[]
}

export type RoadmapIdea = {
  id: string
  title: string
  bodyHtml: string
  created_at: string
  updated_at: string
}

export type RoadmapNodeStatus =
  | 'planned'
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'closed'

export type RoadmapNode = {
  id: string
  title: string
  status: RoadmapNodeStatus
  content: string
  children: RoadmapNode[]
}

export type RoadmapProject = {
  id: string
  owner_id: string
  name: string
  slug: string
  document: RoadmapDocument
  created_at: string
  updated_at: string
}
