import { useEffect, useState } from 'react';
import { CatalogPage } from './catalog/CatalogPage.js';
import { ProductDetailPage } from './catalog/ProductDetailPage.js';
import { AccountPage } from './auth/AccountPage.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { CartProvider, useCart } from './cart/CartContext.js';
import { CartPage } from './cart/CartPage.js';

function currentRoute(): string {
  return window.location.hash.slice(1) || '/';
}

function Application() {
  const [route, setRoute] = useState(currentRoute);
  const { user, logout } = useAuth();
  const { cart } = useCart();

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const [rawPath, query = ''] = route.split('?', 2);
  const path = rawPath ?? '/';
  const productMatch = /^\/producto\/([0-9a-f-]+)$/i.exec(path);
  let page = <CatalogPage />;
  if (productMatch?.[1]) page = <ProductDetailPage productId={productMatch[1]} />;
  else if (path === '/login') {
    const returnTo = new URLSearchParams(query).get('returnTo') ?? '#/pedidos';
    page = <LoginPage returnTo={returnTo} />;
  } else if (path === '/registro') page = <RegisterPage />;
  else if (path === '/pedidos') page = <AccountPage />;
  else if (path === '/carrito') page = <CartPage />;

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
          {user?.role === 'CLIENTE' && (
            <a href="#/carrito" aria-label={`Carrito, ${cart?.itemCount ?? 0} unidades`}>
              Carrito <span className="cart-count">{cart?.itemCount ?? 0}</span>
            </a>
          )}
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
      <CartProvider>
        <Application />
      </CartProvider>
    </AuthProvider>
  );
}
