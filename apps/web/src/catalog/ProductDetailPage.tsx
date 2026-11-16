import { useEffect, useState } from 'react';
import type { ProductDetail } from '@spectra/contracts';
import { CatalogApiError, getProduct } from './catalog-api.js';
import { formatPrice } from './ProductCard.js';
import { useAuth } from '../auth/AuthContext.js';
import { useCart } from '../cart/CartContext.js';

const LABELS = {
  OUT_OF_STOCK: 'Agotado',
  LOW_STOCK: 'Últimas unidades',
  AVAILABLE: 'Disponible',
} as const;

export function ProductDetailPage({ productId }: { productId: string }) {
  const [product, setProduct] = useState<ProductDetail>();
  const [error, setError] = useState<CatalogApiError>();
  const [reloadKey, setReloadKey] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [cartMessage, setCartMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const { user } = useAuth();
  const { add } = useCart();

  useEffect(() => {
    const controller = new AbortController();
    setProduct(undefined);
    setError(undefined);
    void getProduct(productId, controller.signal)
      .then(setProduct)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(
          caught instanceof CatalogApiError
            ? caught
            : new CatalogApiError('Producto no disponible'),
        );
      });
    return () => controller.abort();
  }, [productId, reloadKey]);

  if (error) {
    return (
      <main className="detail-page">
        <a className="back-link" href="#/">
          ← Volver al catálogo
        </a>
        <div className="state-card error-state">
          <h1>Producto no disponible</h1>
          <p>
            No pudimos encontrar este producto.{' '}
            {error.requestId && (
              <>
                Referencia: <code>{error.requestId}</code>
              </>
            )}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  if (!product)
    return (
      <main className="detail-page">
        <div className="state-card">
          <span className="spinner" />
          Cargando producto…
        </div>
      </main>
    );

  const selectedProduct = product;
  const exhausted = selectedProduct.availability === 'OUT_OF_STOCK';
  async function addSelected(): Promise<void> {
    if (!user) {
      window.location.hash = `/login?returnTo=${encodeURIComponent(`#/producto/${selectedProduct.id}`)}`;
      return;
    }
    if (user.role !== 'CLIENTE') return;
    setAdding(true);
    setCartMessage('');
    try {
      await add(selectedProduct.id, quantity);
      setCartMessage('Producto agregado al carrito');
    } catch (caught: unknown) {
      setCartMessage(caught instanceof Error ? caught.message : 'No fue posible agregar');
    } finally {
      setAdding(false);
    }
  }
  return (
    <main className="detail-page">
      <a className="back-link" href="#/">
        ← Volver al catálogo
      </a>
      <article className="detail-card">
        <div
          className={`detail-visual visual-${product.category.slug}`}
          role="img"
          aria-label={`Imagen de ${product.name}`}
        >
          <span aria-hidden="true">◇</span>
        </div>
        <div className="detail-copy">
          <p className="eyebrow">
            {product.category.name} · {product.sku}
          </p>
          <h1>{product.name}</h1>
          <p className="detail-description">{product.description}</p>
          <strong className="detail-price">{formatPrice(product.price)}</strong>
          <p className={`availability availability-${product.availability.toLowerCase()}`}>
            {LABELS[product.availability]}
          </p>
          {!exhausted && (
            <label className="quantity-field">
              <span>Cantidad</span>
              <input
                type="number"
                min="1"
                max="10"
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </label>
          )}
          <button
            className="primary-button add-button"
            type="button"
            disabled={exhausted || adding || user?.role === 'ADMIN'}
            title={user?.role === 'ADMIN' ? 'Los administradores no compran' : undefined}
            onClick={() => void addSelected()}
          >
            {exhausted ? 'Agotado' : adding ? 'Agregando…' : 'Agregar al carrito'}
          </button>
          {cartMessage && <small role="status">{cartMessage}</small>}
        </div>
      </article>
    </main>
  );
}
