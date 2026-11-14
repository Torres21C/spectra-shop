import { type FormEvent, useEffect, useState } from 'react';
import type { CategorySummary, ProductPage } from '@spectra/contracts';
import { CatalogApiError, getCategories, getProducts } from './catalog-api.js';
import { ProductCard } from './ProductCard.js';

const EMPTY_PAGE: ProductPage = {
  items: [],
  meta: { page: 1, pageSize: 12, totalItems: 0, totalPages: 0 },
};

export function CatalogPage() {
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ProductPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogApiError>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void getCategories(controller.signal)
      .then(setCategories)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void getProducts(
      { ...(search ? { search } : {}), ...(category ? { category } : {}), page },
      controller.signal,
    )
      .then(setResult)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(
          caught instanceof CatalogApiError
            ? caught
            : new CatalogApiError('No fue posible consultar el catálogo'),
        );
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [category, page, reloadKey, search]);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = draftSearch.trim();
    if (normalized.length === 1) return;
    setSearch(normalized);
    setPage(1);
  }

  function clearFilters(): void {
    setDraftSearch('');
    setSearch('');
    setCategory('');
    setPage(1);
  }

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">Tecnología para tu espacio</p>
        <h1>Encuentra tu próxima pieza favorita.</h1>
        <p>Una selección sintética de periféricos y accesorios para el laboratorio SPECTRA.</p>
      </section>

      <section className="catalog-panel" aria-labelledby="catalog-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Colección</p>
            <h2 id="catalog-title">Catálogo de productos</h2>
          </div>
          <span>{result.meta.totalItems} productos</span>
        </div>

        <form className="filters" onSubmit={submitSearch}>
          <label className="search-field">
            <span>Buscar productos</span>
            <input
              type="search"
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Ej. teclado"
              minLength={2}
              maxLength={50}
            />
          </label>
          <label>
            <span>Categoría</span>
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Todas</option>
              {categories.map((item) => (
                <option key={item.id} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" type="submit">
            Buscar
          </button>
        </form>

        {search && <p className="search-summary">Resultados para “{search}”</p>}

        <div aria-live="polite">
          {loading && (
            <div className="state-card">
              <span className="spinner" />
              Cargando catálogo…
            </div>
          )}
          {!loading && error && (
            <div className="state-card error-state">
              <h3>No pudimos cargar los productos</h3>
              <p>
                Intenta nuevamente.{' '}
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
          )}
          {!loading && !error && result.items.length === 0 && (
            <div className="state-card">
              <h3>No encontramos productos</h3>
              <p>Prueba con otro término o limpia los filtros.</p>
              <button className="secondary-button" type="button" onClick={clearFilters}>
                Limpiar filtros
              </button>
            </div>
          )}
          {!loading && !error && result.items.length > 0 && (
            <div className="product-grid">
              {result.items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </div>

        {!loading && !error && result.meta.totalPages > 1 && (
          <nav className="pagination" aria-label="Paginación del catálogo">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Anterior
            </button>
            <span>
              Página {page} de {result.meta.totalPages}
            </span>
            <button
              type="button"
              disabled={page >= result.meta.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Siguiente
            </button>
          </nav>
        )}
      </section>
    </main>
  );
}
