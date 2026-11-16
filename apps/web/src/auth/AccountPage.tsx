import { useAuth } from './AuthContext.js';

export function AccountPage() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <main className="auth-page">
        <p>Cargando sesión…</p>
      </main>
    );
  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>Tu cuenta</h1>
          <p>Inicia sesión para consultar tu perfil.</p>
          <a className="primary-link" href="#/login">
            Iniciar sesión
          </a>
        </section>
      </main>
    );
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Perfil propio</p>
        <h1>{user.fullName}</h1>
        <dl className="profile-list">
          <div>
            <dt>Correo</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Rol</dt>
            <dd>{user.role}</dd>
          </div>
          <div>
            <dt>Registro</dt>
            <dd>{new Date(user.createdAt).toLocaleDateString('es-GT')}</dd>
          </div>
        </dl>
        <p className="orders-placeholder">El historial de pedidos se incorporará en M05.</p>
      </section>
    </main>
  );
}
