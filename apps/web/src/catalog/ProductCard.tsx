import type { ProductSummary } from '@spectra/contracts';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.js';
import { useCart } from '../cart/CartContext.js';

const GLYPHS: Readonly<Record<string, string>> = {
  keyboard: '⌨',
  'keyboard-compact': '⌨',
  headphones: '◉',
  speaker: '▥',
  mouse: '◒',
  hub: '◇',
  stand: '△',
  microphone: '♩',
  lamp: '☼',
  mousepad: '▰',
  earbuds: '◌',
  camera: '▣',
  cable: '∿',
};

const AVAILABILITY_LABELS = {
  OUT_OF_STOCK: 'Agotado',
  LOW_STOCK: 'Últimas unidades',
  AVAILABLE: 'Disponible',
} as const;

export function formatPrice(price: string): string {
  return new Intl.NumberFormat('es-GT', {
    style: 'currency',
    currency: 'GTQ',
    minimumFractionDigits: 2,
  }).format(Number(price));
}

export function ProductCard({ product }: { product: ProductSummary }) {
  const { user } = useAuth();
  const { add } = useCart();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const exhausted = product.availability === 'OUT_OF_STOCK';

  async function addOne(): Promise<void> {
    if (!user) {
      window.location.hash = `/login?returnTo=${encodeURIComponent(`#/producto/${product.id}`)}`;
      return;
    }
    if (user.role !== 'CLIENTE') return;
    setBusy(true);
    setMessage('');
    try {
      await add(product.id, 1);
      setMessage('Agregado al carrito');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'No fue posible agregar el producto');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="product-card">
      <a className="product-link" href={`#/producto/${encodeURIComponent(product.id)}`}>
        <div
          className={`product-visual visual-${product.category.slug}`}
          role="img"
          aria-label={`Imagen de ${product.name}`}
        >
          <span aria-hidden="true">{GLYPHS[product.imageKey] ?? '◇'}</span>
        </div>
        <div className="product-copy">
          <div className="card-meta">
            <span>{product.category.name}</span>
            <span className={`availability availability-${product.availability.toLowerCase()}`}>
              {AVAILABILITY_LABELS[product.availability]}
            </span>
          </div>
          <h2>{product.name}</h2>
          <p>{product.description}</p>
          <strong>{formatPrice(product.price)}</strong>
        </div>
      </a>
      {!exhausted && user?.role !== 'ADMIN' && (
        <div className="card-actions">
          <button
            className="primary-button"
            disabled={busy}
            type="button"
            onClick={() => void addOne()}
          >
            {busy ? 'Agregando…' : 'Agregar al carrito'}
          </button>
          {message && <small role="status">{message}</small>}
        </div>
      )}
    </article>
  );
}
