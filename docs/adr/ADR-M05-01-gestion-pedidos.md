# ADR-M05-01 — Gestión de pedidos del cliente: línea de tiempo por columnas, paginación del servidor y acceso por propietario

- **Estado:** decisiones D-M05-01 a D-M05-07 aprobadas por el propietario del proyecto al autorizar M05 (2026-11-16).
- **Módulo:** M05 Gestión de pedidos (RF-026 a RF-029, RN-20 a RN-22, CA-M05-01 a CA-M05-04; P07 con RF-011).
- **Riesgos y controles:** T04/R04 (IDOR), T09 (XSS), T12 (datos en logs), T13 (errores verbosos) · RS02, RS03, RS04, RS07, RS11 · CTL-06, CTL-07, CTL-10, CTL-16, CTL-17.

## Contexto

M04 deja pedidos `PAGADO` con `paid_at`, líneas con precio y nombre congelados y una consulta `GET /orders/:id` limitada al propietario para la confirmación P06. M05 debe ofrecer al cliente el historial, el detalle y la línea de tiempo de sus pedidos sin permitirle modificar nada, y sin romper los pedidos ni la pantalla de confirmación de M04. Los cambios de estado los hará el administrador en M06, que todavía no existe.

## Decisiones

1. **D-M05-01. Línea de tiempo por columnas de fecha.** `orders` incorpora `preparing_at`, `shipped_at`, `delivered_at` y `cancelled_at` junto al `paid_at` de M04 (ERS §8.2, D-08), en lugar de una tabla de historial. Dos restricciones garantizan la coherencia en la base de datos:
   - `orders_timeline_status_check`: cada estado exige exactamente las fechas de los estados por los que pasó según RN-24. `CANCELADO` sólo es posible sin `shipped_at` ni `delivered_at`.
   - `orders_timeline_chronology_check`: las fechas son monótonas (`paid ≤ preparing ≤ shipped ≤ delivered`, `cancelled ≥ preparing o paid`).

   `statusChangedAt` es la fecha de la columna del estado vigente, por lo que coincide con el último cambio registrado (CA-M05-04). Si una fila fuera incoherente, la API falla cerrado (500 genérico) en lugar de mostrar una fecha equivocada.

2. **D-M05-02. CA-M05-04 con transiciones simuladas.** La prueba de integración aplica los cambios con `simulateAdminTransition` (estado + fecha en una sentencia) y comprueba la API tras cada paso. La validación integral se completará en M06, que debe escribir estado y fecha en la misma sentencia.
3. **D-M05-03. UUID en API y frontend.** Las rutas usan el UUID v4 (`/orders/:orderId`, `#/pedidos/:uuid`). El número `SP-…` se muestra pero nunca se usa como identificador; cualquier otro valor responde `400` en la API y el estado E-404 en el frontend, sin consultar la API.
4. **D-M05-04. Paginación fija de 10 controlada por el servidor.** `GET /orders` sólo acepta `page` (1–10 000). El orden es `created_at DESC, id DESC`, estable ante empates, con el índice `orders_user_id_created_at_id_idx`. El DTO en lista blanca rechaza `pageSize`, `limit`, `userId` y cualquier otro parámetro.
5. **D-M05-05. `ACCESS_DENIED` en la outbox.** Se conserva el comportamiento de M04: el intento sobre un pedido ajeno escribe `ACCESS_DENIED` (actor, rol, IP, recurso, resultado, `requestId` y fecha; metadatos en lista blanca) en `commerce.outbox_events`. La entrega a `audit-service` corresponde a M07.
6. **D-M05-06. `Cache-Control: no-store`.** El `NoStoreMiddleware` de M04.1 ya cubre todas las respuestas de Commerce, incluidas las de M05 (200, 400, 401, 404).
7. **D-M05-07. P07.** `#/pedidos` muestra el perfil (RF-011) y el historial paginado; `#/pedidos/:uuid`, el detalle con la línea de tiempo. Una sesión expirada redirige al login; un pedido ajeno o inexistente muestra el mismo estado «Pedido no encontrado».

## Compatibilidad con M04

- La migración `20261118090000_m05_order_timeline` sólo añade columnas anulables y restricciones que los pedidos de M04 ya cumplen. Se verificó aplicándola sobre pedidos con la forma de M04 (`EV-M05-PEDIDOS-LOCAL-20261116`).
- `GET /orders/:orderId` pasa de `CheckoutController` a `OrdersController` en la misma ruta. Su respuesta es la confirmación de M04 más `statusChangedAt` y `timeline` (cambio aditivo). `POST /orders` sigue devolviendo la confirmación de M04 sin cambios.

## Consecuencias

- Los historiales sólo exponen número, fechas, estado, cantidad de artículos y total; la entrega y la referencia de pago aparecen únicamente en el detalle.
- El cliente no tiene rutas de modificación ni cancelación (RN-22). Un `PATCH`, `PUT`, `DELETE` o `POST …/cancel` responde 404 sin efectos.
- **Límite conocido:** el 404 es idéntico en contenido, pero un pedido ajeno implica una consulta y una escritura más que uno inexistente. Con UUID v4 la enumeración no es práctica, por lo que esta diferencia de tiempo no se mitiga en M05.
- **Alternativa descartada:** la tabla `OrderStatusHistory` permitiría registrar actor y motivo de cada cambio, pero eso corresponde a la auditoría de M06/M07 (RN-26) y duplicaría la fuente de verdad del estado.
