import { createClient } from 'npm:@supabase/supabase-js@2'

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
}

type RoadmapDocument = {
  schemaVersion: unknown
  project: unknown
  nodes: unknown
}

type RoadmapProjectRow = {
  id: string
  name: string
  slug: string
  document: RoadmapDocument
  updated_at: string
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  })
}

function isValidDocument(document: RoadmapDocument | null): document is RoadmapDocument & {
  schemaVersion: 1
  project: Record<string, unknown>
  nodes: unknown[]
} {
  return (
    document !== null &&
    document.schemaVersion === 1 &&
    Array.isArray(document.nodes)
  )
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' })
  }

  const syncToken = Deno.env.get('ARBORIA_SYNC_TOKEN')
  const authorization = request.headers.get('Authorization')

  if (!syncToken || authorization !== `Bearer ${syncToken}`) {
    return jsonResponse(401, { error: 'unauthorized' })
  }

  const slug = new URL(request.url).searchParams.get('slug')

  if (!slug) {
    return jsonResponse(400, { error: 'missing_slug' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'server_not_configured' })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  const { data, error } = await supabase
    .from('roadmap_projects')
    .select('id,name,slug,document,updated_at')
    .eq('slug', slug)

  if (error) {
    return jsonResponse(500, { error: 'roadmap_lookup_failed' })
  }

  const rows = (data ?? []) as RoadmapProjectRow[]

  if (rows.length === 0) {
    return jsonResponse(404, { error: 'project_not_found' })
  }

  if (rows.length > 1) {
    return jsonResponse(409, { error: 'duplicate_project_slug' })
  }

  const project = rows[0]

  if (!isValidDocument(project.document)) {
    return jsonResponse(500, { error: 'invalid_roadmap_document' })
  }

  return jsonResponse(200, {
    source: 'arboria',
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      updatedAt: project.updated_at,
    },
    document: project.document,
  })
})
