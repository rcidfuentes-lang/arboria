import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AutorizarConector } from './components/AutorizarConector'
import { Login } from './components/Login'
import { ProjectList } from './components/ProjectList'
import { RUTA_AUTORIZAR } from './lib/mcp-conector'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './styles.css'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loadingSession, setLoadingSession] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoadingSession(false)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoadingSession(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession)
      setLoadingSession(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (!isSupabaseConfigured) {
    return (
      <main className="auth-shell">
        <section className="login-panel" aria-labelledby="config-title">
          <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
          <div>
            <p className="eyebrow">Arboria</p>
            <h1 id="config-title">Falta configurar Supabase</h1>
            <p className="muted">
              Anade VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en las
              variables de entorno de Netlify y vuelve a desplegar.
            </p>
          </div>
        </section>
      </main>
    )
  }

  if (loadingSession) {
    return (
      <main className="auth-shell">
        <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
        <p>Preparando Arboria...</p>
      </main>
    )
  }

  // Unica ruta de la aplicacion que no es el editor: el endpoint de
  // autorizacion del conector MCP. Se resuelve aqui, mirando el camino, porque
  // Arboria no tiene enrutador y meter uno por una pantalla seria empezar la
  // casa por el tejado. La pantalla gestiona ella misma el caso de no haber
  // sesion, porque despues de iniciarla hay que seguir con la misma peticion.
  if (window.location.pathname === RUTA_AUTORIZAR) {
    return <AutorizarConector session={session} />
  }

  if (!session) {
    return <Login />
  }

  return <ProjectList session={session} />
}

export default App
