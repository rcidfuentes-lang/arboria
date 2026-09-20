import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Login } from './Login'
import { supabase } from '../lib/supabase'
import { ALCANCE, recursoAceptado, recursoCanonico } from '../lib/mcp-conector'

/**
 * Pantalla de autorizacion del conector MCP.
 *
 * Es el endpoint de autorizacion de OAuth, y a proposito no es una funcion de
 * servidor: aqui hay que saber quien es Ruben y que proyectos son suyos, y eso
 * ya lo sabe la aplicacion. Hacerlo en el servidor obligaria a manejar la
 * sesion de Supabase fuera del navegador sin ganar nada.
 *
 * El codigo de autorizacion lo genera este navegador y no sale de el mas que
 * en la redireccion al cliente: a la base solo va su SHA-256. Ni Netlify ni
 * Arboria llegan a ver nunca un codigo en claro.
 *
 * Lo que no se decide aqui es si la peticion es legitima. Que el proyecto sea
 * de quien lo concede y que la redireccion este registrada para ese cliente lo
 * comprueba otra vez la funcion de la base, que es quien manda. Estas
 * comprobaciones estan para poder enseñar el error, no para autorizar.
 */

type AutorizarConectorProps = {
  session: Session | null
}

type Proyecto = { id: string; name: string; updated_at: string }

type Estado =
  | { fase: 'comprobando' }
  | { fase: 'rechazada'; motivo: string }
  | { fase: 'lista'; cliente: string }

function base64url(bytes: Uint8Array) {
  let binario = ''
  for (const byte of bytes) binario += String.fromCharCode(byte)
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(texto: string) {
  const resumen = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return Array.from(new Uint8Array(resumen))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function formatearFecha(valor: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(valor),
  )
}

export function AutorizarConector({ session }: AutorizarConectorProps) {
  const parametros = new URLSearchParams(window.location.search)
  const clientId = parametros.get('client_id') ?? ''
  const redireccion = parametros.get('redirect_uri') ?? ''
  const estadoDelCliente = parametros.get('state')
  const reto = parametros.get('code_challenge') ?? ''
  const metodoDelReto = parametros.get('code_challenge_method') ?? ''
  const tipoDeRespuesta = parametros.get('response_type') ?? ''
  const recursoPedido = parametros.get('resource')
  const origen = `${window.location.protocol}//${window.location.host}`

  const [estado, setEstado] = useState<Estado>({ fase: 'comprobando' })
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [elegido, setElegido] = useState<string>('')
  const [concediendo, setConcediendo] = useState(false)
  const [errorAlConceder, setErrorAlConceder] = useState('')

  function volverAlCliente(campos: Record<string, string>) {
    const destino = new URL(redireccion)
    for (const [clave, valor] of Object.entries(campos)) destino.searchParams.set(clave, valor)
    if (estadoDelCliente !== null) destino.searchParams.set('state', estadoDelCliente)
    // RFC 9207: el cliente compara este iss con el que descubrio, y asi no le
    // pueden colar una respuesta de otro servidor de autorizacion.
    destino.searchParams.set('iss', origen)
    window.location.replace(destino.toString())
  }

  useEffect(() => {
    let vigente = true

    async function comprobar() {
      if (!supabase || !session) return

      // Antes de validar al cliente no se redirige a ninguna parte: una
      // redireccion sin comprobar es justo lo que busca quien manda un enlace
      // de autorizacion preparado.
      if (!clientId || !redireccion) {
        setEstado({
          fase: 'rechazada',
          motivo: 'La peticion no trae client_id o redirect_uri. No hay adonde volver.',
        })
        return
      }

      const { data, error } = await supabase.rpc('mcp_client_for_authorization', {
        client_id: clientId,
        redirect_uri: redireccion,
      })

      if (!vigente) return

      if (error) {
        setEstado({ fase: 'rechazada', motivo: `No se ha podido comprobar el cliente: ${error.message}` })
        return
      }

      if (!data) {
        setEstado({
          fase: 'rechazada',
          motivo:
            'Este conector no esta registrado en Arboria, o la direccion de retorno ' +
            'que pide no es una de las suyas. No se redirige a ninguna parte.',
        })
        return
      }

      // A partir de aqui la redireccion esta comprobada, asi que los errores ya
      // se pueden devolver al cliente como manda OAuth.
      if (tipoDeRespuesta !== 'code') {
        volverAlCliente({
          error: 'unsupported_response_type',
          error_description: 'Solo response_type=code.',
        })
        return
      }
      if (metodoDelReto !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(reto)) {
        volverAlCliente({
          error: 'invalid_request',
          error_description: 'Hace falta PKCE con code_challenge_method=S256.',
        })
        return
      }
      if (recursoPedido !== null && !recursoAceptado(recursoPedido, origen)) {
        volverAlCliente({
          error: 'invalid_target',
          error_description: 'El parametro resource no nombra a este servidor MCP.',
        })
        return
      }

      const listado = await supabase
        .from('roadmap_projects')
        .select('id, name, updated_at')
        .order('updated_at', { ascending: false })

      if (!vigente) return

      if (listado.error) {
        setEstado({
          fase: 'rechazada',
          motivo: `No se han podido cargar los proyectos: ${listado.error.message}`,
        })
        return
      }

      const filas = (listado.data ?? []) as Proyecto[]
      setProyectos(filas)
      setElegido(filas[0]?.id ?? '')
      setEstado({ fase: 'lista', cliente: String((data as { client_name?: string }).client_name ?? 'Cliente MCP') })
    }

    comprobar()
    return () => {
      vigente = false
    }
    // Las dependencias son los parametros de la URL, que no cambian mientras la
    // pagina esta abierta, y la sesion.
  }, [session])

  if (!supabase) return null
  if (!session) return <Login />

  if (estado.fase === 'comprobando') {
    return (
      <main className="auth-shell">
        <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
        <p>Comprobando la peticion del conector...</p>
      </main>
    )
  }

  if (estado.fase === 'rechazada') {
    return (
      <main className="auth-shell">
        <section className="login-panel">
          <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
          <div>
            <p className="eyebrow">Arboria</p>
            <h1>Peticion rechazada</h1>
            <p className="form-error">{estado.motivo}</p>
          </div>
        </section>
      </main>
    )
  }

  async function conceder() {
    if (!supabase || !elegido) return
    setConcediendo(true)
    setErrorAlConceder('')

    const codigo = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const { data, error } = await supabase.rpc('mcp_issue_authorization_code', {
      client_id: clientId,
      project_id: elegido,
      redirect_uri: redireccion,
      code_challenge: reto,
      resource: recursoPedido ?? recursoCanonico(origen),
      code_hash: await sha256Hex(codigo),
    })

    if (error || data !== true) {
      setConcediendo(false)
      setErrorAlConceder(
        error ? error.message : 'Arboria no ha dado por buena la concesion. No se ha emitido nada.',
      )
      return
    }

    volverAlCliente({ code: codigo })
  }

  const proyecto = proyectos.find((fila) => fila.id === elegido)

  return (
    <main className="auth-shell">
      <section className="login-panel" aria-labelledby="autorizar-title">
        <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
        <div>
          <p className="eyebrow">Arboria</p>
          <h1 id="autorizar-title">Conectar {estado.cliente}</h1>
          <p className="muted">
            {estado.cliente} pide leer el roadmap de un proyecto. El permiso es de solo
            lectura ({ALCANCE}) y queda atado al proyecto que elijas: con el no podra leer
            ningun otro, ni saber si existe.
          </p>
        </div>

        {proyectos.length === 0 ? (
          <p className="empty-state">
            Todavia no hay ningun proyecto que conectar. Crea uno en Arboria y vuelve a
            intentarlo.
          </p>
        ) : (
          <div className="stack">
            <label>
              Proyecto
              <select
                disabled={concediendo}
                onChange={(evento) => setElegido(evento.target.value)}
                value={elegido}
              >
                {proyectos.map((fila) => (
                  <option key={fila.id} value={fila.id}>
                    {fila.name}
                  </option>
                ))}
              </select>
            </label>

            {proyecto ? (
              <p className="muted">Ultimo cambio: {formatearFecha(proyecto.updated_at)}</p>
            ) : null}

            <p className="muted">
              Vuelve a <strong>{new URL(redireccion).origin}</strong> como {session.user.email}.
            </p>

            {errorAlConceder ? <p className="form-error">{errorAlConceder}</p> : null}

            <button disabled={concediendo || !elegido} onClick={conceder} type="button">
              {concediendo ? 'Autorizando...' : 'Autorizar la lectura'}
            </button>
            <button
              className="secondary-button"
              disabled={concediendo}
              onClick={() =>
                volverAlCliente({
                  error: 'access_denied',
                  error_description: 'La autorizacion se ha cancelado en Arboria.',
                })
              }
              type="button"
            >
              Cancelar
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
