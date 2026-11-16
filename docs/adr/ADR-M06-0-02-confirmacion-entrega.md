# ADR-M06-0-02 — Confirmación de entrega de reservas (FULFILLED) y detección de reservas sin reconocer (DT-08)

- **Estado:** D-M06-0-07 a D-M06-0-12 implementan el diseño de M06.0 aprobado por el propietario del proyecto (2026-11-16). Las adendas de RN-25 y DT-08/R27 son **propuestas, no aprobadas**; no modifican la ERS ni la matriz de riesgos.
- **Deuda:** DT-08 (antes de M06). **Riesgo:** R27 (inconsistencia por fallo parcial de la saga) **permanece abierto**. **Control:** CTL-39 (reconciliación de la saga), todavía parcial.
- **Relacionado:** [ADR-M04-01](ADR-M04-01-checkout-saga.md), [runbook de sagas atascadas](../runbooks/checkout-sagas-atascadas.md), [ADR-M06-0-01](ADR-M06-0-01-roles-postgresql.md).

## Contexto

En M04/M04.1, después de que Catalog confirma la reserva (punto de no retorno), Commerce crea el pedido en una transacción local (C3). Si Commerce pierde definitivamente su estado antes o después de C3, Catalog conserva el stock descontado y no puede saber si existe un pedido (R27 residual). DT-08 exige que Catalog conozca qué reservas confirmadas tienen pedido y que detecte las que no.

## Decisiones

1. **D-M06-0-07. Estados internos `FULFILLED` y `RESTOCKED`.** `catalog.ReservationStatus` los incorpora en una migración propia (PostgreSQL no permite usar un valor de enum nuevo en la transacción que lo añade). `stock_reservations` añade `order_id` (único), `fulfilled_at` y `restocked_at`, más un índice `(status, confirmed_at)`. La restricción de estados exige las fechas y el vínculo de cada estado; otra garantiza el orden `confirmed ≤ fulfilled ≤ restocked`. No existen transiciones `CONFIRMED → RELEASED` ni `FULFILLED → RELEASED`: `release` responde `409 RESERVATION_CONFIRMED`. `RESTOCKED` se modela, pero lo usará la cancelación de M06. `OrderStatus` no cambia y estos estados nunca se exponen al cliente.
2. **D-M06-0-08. Contrato `fulfill`.** `POST /internal/catalog/stock-reservations/{reservationId}/fulfill` con `{ "orderId": "<uuid v4>" }`, solo en el listener interno (3102) y con el token de alcance de inventario. Es un único `UPDATE … WHERE status = 'CONFIRMED'`. La clave natural de idempotencia es la pareja `reservationId + orderId`.

   | Respuesta                        | Caso                                                                                                   |
   | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
   | `201`                            | Primera transición                                                                                     |
   | `200`                            | Repetición con el mismo pedido, sin cambiar stock ni fechas; también si la reserva ya está `RESTOCKED` |
   | `409 RESERVATION_ORDER_MISMATCH` | La reserva ya está vinculada a otro pedido                                                             |
   | `409 ORDER_RESERVATION_MISMATCH` | El pedido ya está vinculado a otra reserva (índice único)                                              |
   | `409 RESERVATION_NOT_CONFIRMED`  | La reserva sigue `PENDING`                                                                             |
   | `409 RESERVATION_RELEASED`       | La reserva fue liberada                                                                                |
   | `404 RESERVATION_NOT_FOUND`      | La reserva no existe                                                                                   |
   | `400`                            | Validación estricta                                                                                    |
   | `503`                            | Token ausente o de otro alcance                                                                        |

3. **D-M06-0-09. Reconocimiento inmediato y recuperable en Commerce.** C3 deja en el intento un arrendamiento de reconocimiento a nombre del proceso que creó el pedido; ese proceso llama a `fulfill` justo después. Un fallo nunca cambia la respuesta del checkout (el pedido se confirma con 201) ni revierte el pedido. `checkout_attempts` añade `inventory_fulfilled_at`, `fulfillment_attempts`, `fulfillment_next_attempt_at`, `fulfillment_last_error` (lista blanca con CHECK), `fulfillment_stuck_since` y `fulfillment_lease_owner/until`. Estos campos se mantienen separados de la recuperación de la saga de M04.1.
4. **D-M06-0-10. Reconciliador con arrendamiento condicional.** `InventoryFulfillmentRecoveryService` corre al arrancar y cada 15 s (lote 20):
   - toma el intento con un `UPDATE` condicional (sin arrendamiento vigente y con el backoff cumplido);
   - toda escritura posterior exige `fulfillment_lease_owner = <propietario>`, de modo que un proceso que perdió el arrendamiento no puede sobrescribir el resultado;
   - los fallos transitorios o ambiguos se reintentan indefinidamente: 15 s, 30 s, 60 s… hasta 15 min;
   - con 5 fallos o 5 minutos de antigüedad del pedido, se emite una sola alerta (`inventory_fulfillment_stuck` y `INVENTORY_FULFILLMENT_STUCK` en la outbox);
   - un conflicto semántico se marca atascado de inmediato, sin tocar inventario ni pedido;
   - cuando un intento atascado se resuelve, se registra `INVENTORY_FULFILLMENT_RECOVERED`.

   Los pedidos creados antes del despliegue se reconocen en el primer ciclo, sin migración de datos.

5. **D-M06-0-11. Detección del lado de Catalog.** `GET /internal/catalog/stock-reservations/unfulfilled?olderThanSeconds&limit` (`olderThanSeconds` entre 0 y 604 800, por defecto 300; `limit` entre 1 y 100) devuelve el total, la fecha más antigua y, por cada reserva, solo el identificador, la fecha de confirmación y la antigüedad. `InventoryDeliveryMonitorService` publica la métrica `stock_reservation_unfulfilled` al arrancar y cada 60 s. Ninguno de los dos compensa ni libera stock.
6. **D-M06-0-12. Compatibilidad con M04/M04.1.**
   - `confirm` repetido sobre una reserva `FULFILLED` o `RESTOCKED` sigue respondiendo 200.
   - El cliente de Commerce acepta los nuevos estados.
   - Si la reconciliación de una saga no completada encuentra la reserva ya `FULFILLED` o `RESTOCKED`, la trata como `RESERVATION_MISMATCH`: la difiere y alerta, nunca la aborta ni la libera.
   - Los fixtures de pedidos sintéticos de M05 se crean ya reconocidos.

## Garantías y límites

- Todo checkout completado termina con su reserva `FULFILLED` y vinculada a su pedido. Si Catalog no responde, el reconocimiento queda pendiente y convergerá en cuanto vuelva.
- Repetir `fulfill` no modifica stock ni fechas; una reserva o un pedido no pueden vincularse a dos contrapartes.
- Ninguna reserva `CONFIRMED` o `FULFILLED` se libera automáticamente.
- **No garantizado:** si Commerce pierde sus datos de forma permanente, Catalog **detecta** la reserva confirmada sin reconocer, pero su resolución sigue siendo manual (ajuste de inventario auditado en M06). R27 permanece abierto hasta que la revisión académica lo reevalúe con estas evidencias.

## Adendas propuestas (no aprobadas)

> **RN-25 (propuesta).** En la arquitectura de microservicios, la cancelación se implementa mediante una saga idempotente. Catalog repone exactamente las cantidades de la reserva original y registra `RESTOCKED` en una transacción local. Commerce cambia el pedido a `CANCELADO` solo después de recibir esa confirmación, y actualiza estado, fecha y outbox en otra transacción local. Los reintentos no duplican la reposición. No se afirma atomicidad ACID distribuida. Mientras Catalog esté indisponible, el pedido conserva su estado anterior y la cancelación queda pendiente; nunca se presenta `CANCELADO` antes de confirmar la reposición.

> **DT-08/R27 (propuesta).** Después de crear el pedido, Commerce confirma a Catalog la entrega de la reserva mediante la transición idempotente `FULFILLED`. Catalog informa las reservas `CONFIRMED` que superan el umbral sin entrega. El reporte no libera stock. Este control detecta el caso de Commerce no recuperable, pero no elimina toda necesidad de conciliación manual; por ello R27 permanece abierto hasta que las pruebas, las evidencias y la autoridad académica aprueben su reevaluación.
