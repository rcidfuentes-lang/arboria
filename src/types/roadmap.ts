export type RoadmapDocument = {
  schemaVersion: 1
  project: {
    id: string
    name: string
  }
  nodes: RoadmapNode[]
}

export type RoadmapNodeStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export type RoadmapNode = {
  id: string
  title: string
  status: RoadmapNodeStatus
  goal: string
  expectedOutcome: string
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
