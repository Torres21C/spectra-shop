# ADR-M04-01 — Checkout mediante saga orquestada con transacciones ACID locales

- **Estado:** aceptada por el propietario del proyecto el 2026-11-16 (decisiones D-M04-01 a D-M04-07).
- **Módulo:** M04 Checkout (RF-020 a RF-025, RN-14 a RN-19, CA-M04-01 a CA-M04-07).
- **Riesgos y controles:** T02/R02, T21/R20, T07/R07, T04/R04 · RS12, RS05, RS02 · CTL-18, CTL-19, CTL-11, CTL-07.

## Contexto

La ERS (RN-16, RF-023, RS12, CTL-18) pide que la creación del pedido, el descuento de stock y la conversión del carrito sean atómicos, «en una sola transacción». La arquitectura aprobada para el desarrollo cloud-native asigna el inventario a `catalog-service` (esquema `catalog`) y el pedido y el carrito a `commerce-service` (esquema `commerce`), y prohíbe que un servicio lea o escriba tablas de otro. Una transacción ACID única entre ambos servicios solo sería posible violando esa propiedad de los datos, porque hoy comparten un PostgreSQL, o mediante un commit en dos fases (2PC) que Prisma no soporta y que deja bloqueos huérfanos si cae el coordinador.

## Decisión

1. **D-M04-01.** Commerce orquesta una saga en la que cada paso es una transacción ACID local:
   - **C1 (Commerce):** se crea el intento `STARTED`, idempotente por (`user_id`, `Idempotency-Key`), con el carrito bloqueado (`FOR UPDATE`) y como máximo un intento en curso por carrito (índice único parcial).
   - **Validación:** precios, estado y stock vigentes desde Catalog; la huella del resumen detecta el flujo A4; el pago simulado se evalúa aquí. Un pago `RECHAZADO` termina sin reservar.
   - **R (Catalog):** reserva todo-o-nada. Descuenta stock con `UPDATE … WHERE stock >= q AND price = esperado AND activo`, en orden por `product_id`, y conserva `CHECK stock >= 0`.
   - **K (Catalog):** confirmación. Es el **punto de no retorno** y solo procede si la reserva sigue `PENDING` y `expires_at > now()` según el reloj de la base de datos.
   - **C3 (Commerce):** pedido `PAGADO`, `order_items` con precio congelado, carrito `CONVERTIDO`, intento `COMPLETED` y evento `ORDER_CREATED` en la outbox, todo en la misma transacción.
2. **D-M04-02.** Las reservas residen en Catalog (`stock_reservations` y sus líneas) con `confirm` y `release` idempotentes. `release` sobre un identificador desconocido deja una lápida (`RELEASED`) que bloquea una reserva tardía.
3. **D-M04-03.** El pago es un simulador interno. No existen campos, columnas ni payloads de tarjeta; el DTO en lista blanca los rechaza con 400.
4. **D-M04-04.** La `Idempotency-Key` es un UUID v4 único por usuario (índice único permanente) y válido durante 24 h. Un reenvío con la misma clave y el mismo contenido devuelve el resultado guardado. Con otro contenido responde `422 IDEMPOTENCY_KEY_REUSED`, y pasadas las 24 h, `422 IDEMPOTENCY_KEY_EXPIRED`. `orders` conserva además el índice único (`user_id`, `idempotency_key`).
5. **D-M04-05.** Los estados técnicos (`checkout_attempts.state`: `STARTED`, `RESERVED`, `CONFIRMED`, `COMPLETED`, `REJECTED`, `FAILED`, `ABORTED`) están separados de los estados de negocio (`orders.status`: `PAGADO` … `CANCELADO`).
6. **D-M04-06.** Recuperación:
   - **Arrendamiento:** cada intento tiene `lease_owner` y `lease_until`. Las transiciones son condicionales sobre el dueño del arrendamiento.
   - **Reconciliador de Commerce:** corre al arrancar y periódicamente. Si Catalog no confirmó, libera la reserva (hacia atrás → `ABORTED`); si ya confirmó, completa C3 (hacia adelante → `COMPLETED`).
   - **Barrido de Catalog:** libera reservas `PENDING` vencidas. Es seguro porque una reserva vencida ya no puede confirmarse.
   - **Reintentos:** un intento `ABORTED` no tuvo efectos de negocio, así que la misma clave puede reanudarlo con una reserva nueva.
7. **D-M04-07.** Se conserva el contrato documentado `POST /orders`. Se añaden `GET /checkout/summary` (RF-020) y `GET /orders/:id`, este último limitado al propietario y necesario para la pantalla de confirmación P06.

## Adaptación formal de RN-16

| Aspecto            | RN-16 original                          | RN-16 adaptada (esta ADR)                                                                                     |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mecanismo          | Una transacción ACID global             | Saga de transacciones ACID locales con compensación idempotente                                               |
| Pedido sin stock   | Imposible por rollback                  | Imposible: C3 solo se ejecuta tras K y K exige stock ya descontado                                            |
| Stock sin pedido   | Imposible por rollback                  | Transitorio y acotado: la reserva se libera por compensación o vencimiento; nunca queda descontada sin pedido |
| Carrito convertido | En la misma transacción que el pedido   | En la misma transacción local que el pedido (C3)                                                              |
| Visibilidad        | El cliente nunca ve estados intermedios | El cliente nunca recibe éxito antes de C3; un fallo técnico responde `503 CHECKOUT_PENDING`                   |
| Sobreventa         | Bloqueo de fila + `CHECK`               | `UPDATE` condicional + `CHECK stock >= 0` dentro de la transacción de Catalog                                 |
| Consistencia       | Inmediata                               | Eventual y acotada (TTL de reserva de 120 s y arrendamiento de 30 s)                                          |

**Diferencia aceptada:** durante la saga, el catálogo puede mostrar stock reservado como no disponible antes de que exista el pedido, y si el proceso cae ese stock queda retenido hasta la compensación (fallo seguro: puede venderse de menos, nunca de más). Ningún criterio de aceptación CA-M04-01 a CA-M04-07 cambia.

## Discrepancias documentales resueltas

- **DISC-M04-02:** la ERS §8.1 pide claves foráneas `orders.user_id → users` y `order_items.product_id → products`. Entre esquemas de servicios distintos se usan UUID externos con instantánea de nombre y precio; RN-23 (borrado lógico) garantiza la integridad referencial lógica.
- **DISC-M04-03:** el diagrama de la ERS envía `ORDER_CREATED` directamente a Auditoría. Aquí se escribe en `commerce.outbox_events` dentro de C3; la entrega a `audit-service` queda para M07.
- **DISC-M04-04:** el ejemplo de `Fase3_Ejemplos_Mitigacion_Codigo` §4 es monolítico y pasa a ser no normativo; sus controles (`UPDATE` condicional y clave única) se conservan.
- **DISC-M04-05:** para el flujo A4 se usa `cartFingerprint`, un SHA-256 del resumen calculado en el servidor, en lugar de aceptar importes del cliente (CA-M04-04, PT07).
- **DISC-M04-06:** RN-25 (al cancelar, reponer stock en la misma transacción) presenta la misma tensión y se resolverá en M06 con este mismo patrón.

## Consecuencias

- Hay más estados y más pruebas: carreras, fallos parciales, reinicios y vencimientos. Todos se verifican con PostgreSQL y HTTP reales, y con un proxy de fallos solo para pruebas.
- Catalog expone una API interna de escritura protegida por un token de alcance de inventario (`CATALOG_INVENTORY_TOKEN(S)`), distinto del token compartido de lectura y validado al arrancar.
- Riesgo residual: los servicios comparten usuario de PostgreSQL en el laboratorio local, por lo que la separación de esquemas es una convención de código y no un permiso de base de datos (pendiente: roles por servicio). La outbox de Commerce aún no se publica (M07).
