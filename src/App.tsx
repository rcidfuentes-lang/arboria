import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Login } from './components/Login'
import { ProjectList } from './components/ProjectList'
import { supabase } from './lib/supabase'
import './styles.css'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loadingSession, setLoadingSession] = useState(true)

  useEffect(() => {
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

  if (loadingSession) {
    return (
      <main className="auth-shell">
        <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
        <p>Preparando Arboria...</p>
      </main>
    )
  }

  if (!session) {
    return <Login />
  }

  return <ProjectList session={session} />
}

export default App
