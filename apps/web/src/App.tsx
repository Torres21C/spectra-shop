import { useEffect, useState } from 'react';
import { CatalogPage } from './catalog/CatalogPage.js';
import { ProductDetailPage } from './catalog/ProductDetailPage.js';

function currentRoute(): string {
  return window.location.hash.slice(1) || '/';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const productMatch = /^\/producto\/([0-9a-f-]+)$/i.exec(route);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#/" aria-label="SPECTRA Shop, ir al catálogo">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>SPECTRA</span>
        </a>
        <span className="lab-badge">Laboratorio académico</span>
      </header>
      {productMatch?.[1] ? <ProductDetailPage productId={productMatch[1]} /> : <CatalogPage />}
      <footer>
        <span>SPECTRA Shop</span>
        <span>Datos sintéticos · Precios en GTQ con IVA incluido</span>
      </footer>
    </div>
  );
}
