import { useEffect, useState } from 'react';
import type { OrderConfirmation } from '@spectra/contracts';
import { useAuth } from '../auth/AuthContext.js';
import { formatPrice } from '../catalog/ProductCard.js';
import { getOrder } from './checkout-api.js';

export function OrderConfirmationPage({ orderId }: { orderId: string }) {
  const { user, loading: authLoading } = useAuth();
  const [order, setOrder] = useState<OrderConfirmation>();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (user?.role !== 'CLIENTE') return;
    const controller = new AbortController();
    setMessage('');
    getOrder(orderId, controller.signal)
      .then(setOrder)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setMessage(error instanceof Error ? error.message : 'Pedido no encontrado');
      });
    return () => controller.abort();
  }, [orderId, user?.id, user?.role]);

  if (authLoading || (!order && !message && user?.role === 'CLIENTE')) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <span className="spinner" />
          Cargando confirmación…
        </div>
      </main>
    );
  }
  if (!user || user.role !== 'CLIENTE' || !order) {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>Pedido no encontrado</h1>
          <p>{message}</p>
          <a className="primary-link" href="#/">
            Ver catálogo
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="cart-page">
      <section className="cart-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Pedido confirmado · pago simulado</p>
            <h1>¡Gracias! Pedido {order.orderNumber}</h1>
          </div>
          <span className="order-status">{order.status}</span>
        </div>
        <div className="cart-layout">
          <div className="cart-lines">
            {order.items.map((item) => (
              <article className="cart-line confirmation-line" key={item.productId}>
                <div>
                  <h2>{item.name}</h2>
                  <p>
                    {item.quantity} × {formatPrice(item.unitPrice)} (precio congelado)
                  </p>
                </div>
                <strong>{formatPrice(item.lineTotal)}</strong>
              </article>
            ))}
            <article className="cart-line confirmation-line">
              <div>
                <h2>Entrega ficticia</h2>
                <p>
                  {order.shipping.recipientName} · {order.shipping.phone}
                  <br />
                  {order.shipping.address}, {order.shipping.municipality},{' '}
                  {order.shipping.department}
                  {order.shipping.references ? ` · ${order.shipping.references}` : ''}
                </p>
              </div>
            </article>
          </div>
          <aside className="cart-summary">
            <p>Total pagado (simulado)</p>
            <strong>{formatPrice(order.total)}</strong>
            <small>Referencia {order.paymentReference}</small>
            <a className="primary-link" href="#/">
              Seguir comprando
            </a>
          </aside>
        </div>
      </section>
    </main>
  );
}
