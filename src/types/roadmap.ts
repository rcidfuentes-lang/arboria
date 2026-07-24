export type RoadmapDocument = {
  schemaVersion: 1
  project: {
    id: string
    name: string
  }
  nodes: RoadmapNode[]
}

export type RoadmapNodeStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export type RoadmapDocumentRef = {
  title: string
  href: string
}

export type RoadmapNode = {
  id: string
  title: string
  status: RoadmapNodeStatus
  objective: string
  description: string
  expectedResult: string
  inScope: string[]
  outOfScope: string[]
  dependencies: string[]
  documents: RoadmapDocumentRef[]
  commits: string[]
  notes: string
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
