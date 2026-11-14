import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main>
      <p className="eyebrow">Laboratorio académico</p>
      <h1>SPECTRA Shop</h1>
      <p>Fundación cloud-native lista. El catálogo será el primer incremento funcional.</p>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('No se encontró el elemento raíz de la aplicación');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
