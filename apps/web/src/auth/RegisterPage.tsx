import { useState, type FormEvent } from 'react';
import { register } from './auth-api.js';

export function RegisterPage() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await register({
        fullName: typeof data.get('fullName') === 'string' ? (data.get('fullName') as string) : '',
        email: typeof data.get('email') === 'string' ? (data.get('email') as string) : '',
        password: typeof data.get('password') === 'string' ? (data.get('password') as string) : '',
        passwordConfirmation:
          typeof data.get('passwordConfirmation') === 'string'
            ? (data.get('passwordConfirmation') as string)
            : '',
        academicDataAccepted: data.get('academicDataAccepted') === 'on',
      });
      setMessage(result);
      form.reset();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'No fue posible completar el registro');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="register-title">
        <p className="eyebrow">Cuenta de cliente</p>
        <h1 id="register-title">Crea tu cuenta</h1>
        <p>Usa datos sintéticos. La contraseña debe tener entre 12 y 128 caracteres.</p>
        <form onSubmit={(event) => void submit(event)} className="auth-form">
          <label>
            Nombre completo
            <input name="fullName" minLength={2} maxLength={80} autoComplete="name" required />
          </label>
          <label>
            Correo electrónico
            <input name="email" type="email" maxLength={254} autoComplete="email" required />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Confirmación
            <input
              name="passwordConfirmation"
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="check-field">
            <input name="academicDataAccepted" type="checkbox" required />
            Confirmo que utilizaré únicamente datos sintéticos en este laboratorio.
          </label>
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? 'Procesando…' : 'Registrarme'}
          </button>
        </form>
        <a href="#/login">Ya tengo una cuenta</a>
      </section>
    </main>
  );
}
