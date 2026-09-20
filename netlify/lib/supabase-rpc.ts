/**
 * Llamada a una funcion RPC de Supabase desde una funcion de Netlify.
 *
 * Siempre con la clave anonima, que ya es publica en el bundle desplegado.
 * Nunca con la clave de servicio: todas las funciones que se llaman desde
 * aqui son security definer con un alcance nombrado, y ese alcance es la
 * autorizacion. Una clave de servicio seria un permiso general sobre toda la
 * base viajando por una ruta publica.
 */

export type MotivoDeRpc = 'no_configurado' | 'consulta_fallida'

export class ErrorDeRpc extends Error {
  readonly motivo: MotivoDeRpc

  constructor(motivo: MotivoDeRpc) {
    super(motivo)
    this.name = 'ErrorDeRpc'
    this.motivo = motivo
  }
}

export async function llamarRpc(
  funcion: string,
  argumentos: Record<string, unknown>,
): Promise<unknown> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const clave = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!url || !clave) throw new ErrorDeRpc('no_configurado')

  let respuesta: Response
  try {
    respuesta = await fetch(`${url}/rest/v1/rpc/${funcion}`, {
      method: 'POST',
      headers: {
        apikey: clave,
        Authorization: `Bearer ${clave}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(argumentos),
    })
  } catch {
    throw new ErrorDeRpc('consulta_fallida')
  }

  if (!respuesta.ok) throw new ErrorDeRpc('consulta_fallida')

  try {
    return await respuesta.json()
  } catch {
    throw new ErrorDeRpc('consulta_fallida')
  }
}
