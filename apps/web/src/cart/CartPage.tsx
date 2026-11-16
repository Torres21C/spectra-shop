import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.js';
import { formatPrice } from '../catalog/ProductCard.js';
import { useCart } from './CartContext.js';

const REASONS = {
  INACTIVE: 'Producto no disponible',
  OUT_OF_STOCK: 'Agotado',
  INSUFFICIENT_STOCK: 'Stock insuficiente',
} as const;

export function CartPage() {
  const { user, loading: authLoading } = useAuth();
  const { cart, loading, message, update, remove, reload } = useCart();
  const [busyItem, setBusyItem] = useState<string>();

  if (authLoading || loading) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <span className="spinner" />
          Cargando carrito…
        </div>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <h1>Inicia sesión para ver tu carrito</h1>
          <a className="primary-link" href="#/login?returnTo=%23%2Fcarrito">
            Ingresar
          </a>
        </div>
      </main>
    );
  }
  if (user.role !== 'CLIENTE') {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>Acceso no permitido</h1>
        </div>
      </main>
    );
  }
  if (message && !cart) {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>No pudimos cargar el carrito</h1>
          <p>{message}</p>
          <button className="secondary-button" type="button" onClick={() => void reload()}>
            Reintentar
          </button>
        </div>
      </main>
    );
  }
  if (!cart || cart.items.length === 0) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <h1>Tu carrito está vacío</h1>
          <p>Explora el catálogo para agregar productos.</p>
          <a className="primary-link" href="#/">
            Ver catálogo
          </a>
        </div>
      </main>
    );
  }

  async function change(itemId: string, quantity: number): Promise<void> {
    setBusyItem(itemId);
    try {
      await update(itemId, quantity);
    } finally {
      setBusyItem(undefined);
    }
  }
  async function discard(itemId: string): Promise<void> {
    setBusyItem(itemId);
    try {
      await remove(itemId);
    } finally {
      setBusyItem(undefined);
    }
  }

  return (
    <main className="cart-page">
      <section className="cart-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">M03 · Carrito persistente</p>
            <h1>Tu selección</h1>
          </div>
          <span>
            {cart.distinctItems} productos · {cart.itemCount} unidades
          </span>
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        <div className="cart-layout">
          <div className="cart-lines">
            {cart.items.map((item) => (
              <article
                className={`cart-line ${item.available ? '' : 'cart-line-unavailable'}`}
                key={item.id}
              >
                <div>
                  <h2>{item.name}</h2>
                  <p>
                    {item.available
                      ? `${formatPrice(item.unitPrice)} por unidad`
                      : REASONS[item.unavailableReason!]}
                  </p>
                </div>
                <label>
                  Cantidad
                  <select
                    value={item.quantity}
                    disabled={busyItem === item.id || !item.available}
                    onChange={(event) => void change(item.id, Number(event.target.value))}
                  >
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((quantity) => (
                      <option value={quantity} key={quantity}>
                        {quantity}
                      </option>
                    ))}
                  </select>
                </label>
                <strong>
                  {item.available ? formatPrice(item.subtotal) : 'Excluido del total'}
                </strong>
                <button
                  className="secondary-button"
                  disabled={busyItem === item.id}
                  type="button"
                  onClick={() => void discard(item.id)}
                >
                  Eliminar
                </button>
              </article>
            ))}
          </div>
          <aside className="cart-summary">
            <p>Total calculado en servidor</p>
            <strong>{formatPrice(cart.total)}</strong>
            {!cart.checkoutAllowed && (
              <p className="cart-warning">Elimina o ajusta las líneas no disponibles.</p>
            )}
            <button
              className="primary-button"
              type="button"
              disabled
              title="Disponible en M04 Checkout"
            >
              Continuar al checkout · M04
            </button>
            <small>Agregar al carrito no reserva inventario.</small>
          </aside>
        </div>
      </section>
    </main>
  );
}
