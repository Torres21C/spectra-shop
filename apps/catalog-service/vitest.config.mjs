import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las suites comparten el esquema catalog real; se ejecutan en serie para evitar interferencias.
    fileParallelism: false,
    // M06.0: integración con PostgreSQL real (como Commerce). El límite por defecto de 5 s hacía
    // fallar por tiempo la prueba de 20 reservas concurrentes cuando la máquina está cargada
    // (0,2–5,4 s medidos con y sin DT-08). Las aserciones no cambian: un fallo real (sobreventa,
    // agotamiento del pool → 5xx, interbloqueo) sigue haciendo fallar la prueba.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
