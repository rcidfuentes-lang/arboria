import type { FormEvent } from 'react'
import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage('')
    setIsLoading(true)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setErrorMessage(error.message)
    }

    setIsLoading(false)
  }

  return (
    <main className="auth-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <img className="brand-mark" src="/arboria-logo.png" alt="Arboria" />
        <div>
          <p className="eyebrow">Arboria</p>
          <h1 id="login-title">Accede a tus mapas de proyecto</h1>
          <p className="muted">
            Inicia sesion para continuar con tus roadmaps guardados.
          </p>
        </div>

        <form className="stack" onSubmit={handleSubmit}>
          <label>
            Email
            <input
              autoComplete="email"
              disabled={isLoading}
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>

          <label>
            Contrasena
            <input
              autoComplete="current-password"
              disabled={isLoading}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <button disabled={isLoading} type="submit">
            {isLoading ? 'Entrando...' : 'Iniciar sesion'}
          </button>
        </form>
      </section>
    </main>
  )
}
