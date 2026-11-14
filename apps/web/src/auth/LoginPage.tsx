import { useState, type FormEvent } from 'react';
import { login, safeClientReturn } from './auth-api.js';
import { useAuth } from './AuthContext.js';

export function LoginPage() {
  const { setUser } = useAuth();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await login({
        email: typeof data.get('email') === 'string' ? (data.get('email') as string) : '',
        password: typeof data.get('password') === 'string' ? (data.get('password') as string) : '',
        returnTo: '#/pedidos',
      });
      setUser(result.user);
      window.location.hash = safeClientReturn(result.returnTo).slice(1);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'No fue posible iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">Identidad segura</p>
        <h1 id="login-title">Inicia sesión</h1>
        <p>Tu sesión se guarda en cookies seguras; la aplicación nunca expone los tokens.</p>
        <form onSubmit={(event) => void submit(event)} className="auth-form">
          <label>
            Correo electrónico
            <input name="email" type="email" maxLength={254} autoComplete="email" required />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              maxLength={128}
              autoComplete="current-password"
              required
            />
          </label>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? 'Verificando…' : 'Entrar'}
          </button>
        </form>
        <a href="#/registro">Crear una cuenta</a>
      </section>
    </main>
  );
}
