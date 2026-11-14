// CASOS DE PRUEBA SINTÉTICOS (datos de laboratorio) para spectra-frontend.yaml.
import React from 'react';

export function Producto({ descripcion }: { descripcion: string }) {
  return (
    <div>
      {/* ruleid: spectra-react-dangerously-set-inner-html */}
      <p dangerouslySetInnerHTML={{ __html: descripcion }} />
      {/* ok: spectra-react-dangerously-set-inner-html */}
      <p>{descripcion}</p>
    </div>
  );
}

export function guardarSesion(token: string, tema: string) {
  // ruleid: spectra-token-in-web-storage
  localStorage.setItem('accessToken', token);
  // ok: spectra-token-in-web-storage
  localStorage.setItem('tema', tema);
}

export function redirigir(destino: string) {
  // ruleid: spectra-unvalidated-redirect
  window.location.href = destino;
  // ok: spectra-unvalidated-redirect
  window.location.href = '/login';
}
