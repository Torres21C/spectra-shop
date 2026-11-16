import { useEffect, useState } from 'react';
import type { OrderDetail, OrderHistoryPage } from '@spectra/contracts';
import { useAuth } from '../auth/AuthContext.js';
import { CheckoutApiError } from '../checkout/checkout-api.js';
import { getOrderDetail, getOrderHistory, SESSION_EXPIRED } from './orders-api.js';
import { OrderDetailView, OrderHistoryView, ProfileCard } from './OrderViews.js';

type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: unknown };

/** A3: sesión expirada → login con retorno a una ruta interna validada por LoginPage. */
function redirectToLogin(returnTo: string): void {
  window.location.hash = `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof CheckoutApiError && error.code === SESSION_EXPIRED;
}

function isNotFound(error: unknown): boolean {
  return error instanceof CheckoutApiError && error.status === 404;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="state-card">
      <span className="spinner" />
      {label}
    </div>
  );
}

function SignInPrompt({ returnTo }: { returnTo: string }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Tu cuenta</h1>
        <p>Inicia sesión para consultar tu perfil y tus pedidos.</p>
        <a className="primary-link" href={`#/login?returnTo=${encodeURIComponent(returnTo)}`}>
          Iniciar sesión
        </a>
      </section>
    </main>
  );
}

/** P07 Mi cuenta: perfil (RF-011) e historial paginado por el servidor (RF-026). */
export function OrdersPage({ page }: { page: number }) {
  const { user, loading } = useAuth();
  const [history, setHistory] = useState<Load<OrderHistoryPage>>({ kind: 'loading' });

  useEffect(() => {
    if (user?.role !== 'CLIENTE') return;
    const controller = new AbortController();
    setHistory({ kind: 'loading' });
    getOrderHistory(page, controller.signal)
      .then((value) => setHistory({ kind: 'ready', value }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (isSessionExpired(error)) redirectToLogin('#/pedidos');
        setHistory({ kind: 'error', error });
      });
    return () => controller.abort();
  }, [page, user?.id, user?.role]);

  if (loading) {
    return (
      <main className="cart-page">
        <Loading label="Cargando sesión…" />
      </main>
    );
  }
  if (!user) return <SignInPrompt returnTo="#/pedidos" />;

  return (
    <main className="cart-page">
      <div className="account-layout">
        <ProfileCard user={user} />
        {user.role === 'CLIENTE' && (
          <section className="orders-panel" aria-labelledby="orders-title">
            <div className="section-heading">
              <h2 id="orders-title">Mis pedidos</h2>
              {history.kind === 'ready' && (
                <span>
                  {history.value.meta.totalItems}{' '}
                  {history.value.meta.totalItems === 1 ? 'pedido' : 'pedidos'}
                </span>
              )}
            </div>
            {history.kind === 'loading' && <Loading label="Cargando pedidos…" />}
            {history.kind === 'error' && (
              <div className="state-card error-state" role="alert">
                <h3>No fue posible cargar tus pedidos</h3>
                <p>
                  {history.error instanceof Error
                    ? history.error.message
                    : 'Intenta de nuevo más tarde.'}
                </p>
              </div>
            )}
            {history.kind === 'ready' && <OrderHistoryView history={history.value} />}
          </section>
        )}
      </div>
    </main>
  );
}

/** P07 detalle (`#/pedidos/:uuid`). Pedido ajeno o inexistente → E-404 idéntico (RF-029). */
export function OrderDetailPage({ orderId }: { orderId: string }) {
  const { user, loading } = useAuth();
  const [order, setOrder] = useState<Load<OrderDetail>>({ kind: 'loading' });

  useEffect(() => {
    if (user?.role !== 'CLIENTE') return;
    const controller = new AbortController();
    setOrder({ kind: 'loading' });
    getOrderDetail(orderId, controller.signal)
      .then((value) => setOrder({ kind: 'ready', value }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (isSessionExpired(error)) redirectToLogin(`#/pedidos/${orderId}`);
        setOrder({ kind: 'error', error });
      });
    return () => controller.abort();
  }, [orderId, user?.id, user?.role]);

  if (loading || (user?.role === 'CLIENTE' && order.kind === 'loading')) {
    return (
      <main className="cart-page">
        <Loading label="Cargando pedido…" />
      </main>
    );
  }
  if (!user) return <SignInPrompt returnTo="#/pedidos" />;
  if (user.role !== 'CLIENTE' || order.kind !== 'ready') {
    const notFound = user.role !== 'CLIENTE' || (order.kind === 'error' && isNotFound(order.error));
    return (
      <main className="cart-page">
        <div className="state-card error-state" role="alert">
          <h1>{notFound ? 'Pedido no encontrado' : 'No fue posible cargar el pedido'}</h1>
          {!notFound && order.kind === 'error' && order.error instanceof Error && (
            <p>{order.error.message}</p>
          )}
          <a className="primary-link" href="#/pedidos">
            Ver mis pedidos
          </a>
        </div>
      </main>
    );
  }
  return (
    <main className="cart-page">
      <OrderDetailView order={order.value} />
    </main>
  );
}
