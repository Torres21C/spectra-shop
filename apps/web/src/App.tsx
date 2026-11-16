import { useEffect, useState } from 'react';
import { CatalogPage } from './catalog/CatalogPage.js';
import { ProductDetailPage } from './catalog/ProductDetailPage.js';
import { AccountPage } from './auth/AccountPage.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';

function currentRoute(): string {
  return window.location.hash.slice(1) || '/';
}

function Application() {
  const [route, setRoute] = useState(currentRoute);
  const { user, logout } = useAuth();

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const productMatch = /^\/producto\/([0-9a-f-]+)$/i.exec(route);
  let page = <CatalogPage />;
  if (productMatch?.[1]) page = <ProductDetailPage productId={productMatch[1]} />;
  else if (route === '/login') page = <LoginPage />;
  else if (route === '/registro') page = <RegisterPage />;
  else if (route === '/pedidos') page = <AccountPage />;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#/" aria-label="SPECTRA Shop, ir al catálogo">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>SPECTRA</span>
        </a>
        <nav className="account-nav" aria-label="Cuenta">
          <span className="lab-badge">Laboratorio académico</span>
          {user ? (
            <>
              <a href="#/pedidos">{user.fullName}</a>
              <button type="button" onClick={() => void logout()}>
                Salir
              </button>
            </>
          ) : (
            <>
              <a href="#/login">Ingresar</a>
              <a href="#/registro">Registro</a>
            </>
          )}
        </nav>
      </header>
      {page}
      <footer>
        <span>SPECTRA Shop</span>
        <span>Datos sintéticos · Precios en GTQ con IVA incluido</span>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Application />
    </AuthProvider>
  );
}
