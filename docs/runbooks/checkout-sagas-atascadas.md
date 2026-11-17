# Runbook — sagas de checkout atascadas (M04.1)

Procedimiento operativo para la alerta `checkout_saga_stuck`: log de error de `commerce-service` y evento técnico `CHECKOUT_SAGA_STUCK` en `commerce.outbox_events`. Referencias: ADR-M04-01 («Garantías y límites»), CTL-39 (parcial) y R27.

## Regla principal

**Nunca liberar a mano una reserva `CONFIRMED` de Catalog ni marcar como terminado un intento que haya pasado el punto de no retorno.** Una reserva `CONFIRMED` significa que el stock ya se descontó para un pedido que Commerce debe crear. Liberarla sin protocolo puede vender ese stock dos veces.

## Señales

| Señal                                                 | Dónde                                                      | Significado                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout_saga_stuck` / `CHECKOUT_SAGA_STUCK`         | Log de error y outbox                                      | Saga en curso con al menos `CHECKOUT_STUCK_ATTEMPTS` reintentos (5 por defecto) o más antigua que `CHECKOUT_STUCK_AGE_MS` (5 min). Se emite una sola vez por saga |
| `checkout_saga_metrics`                               | Log de cada ciclo del reconciliador (error si `stuck > 0`) | `inflight` por estado, `stuck`, antigüedad máxima, reintentos máximos y próximo reintento                                                                         |
| `checkout_recovery_deferred`                          | Log por reintento fallido                                  | `errorCode` en lista blanca y `retryInMs` aplicado                                                                                                                |
| `checkout_saga_recovered` / `CHECKOUT_SAGA_RECOVERED` | Log y outbox                                               | La saga atascada terminó (`COMPLETED` o `ABORTED`)                                                                                                                |

`errorCode` y `lastRecoveryError` toman uno de estos valores: `INVENTORY_UNAVAILABLE`, `RESERVATION_MISMATCH`, `PERSISTENCE_ERROR` o `UNEXPECTED_ERROR`. Nunca se registran mensajes de error ni datos personales.

## Diagnóstico (solo lectura)

```sql
-- Commerce: sagas en curso marcadas como atascadas
SELECT id, state, recovery_attempts, last_recovery_error, next_recovery_at, stuck_since, created_at
  FROM commerce.checkout_attempts
 WHERE state IN ('STARTED', 'RESERVED', 'CONFIRMED') AND stuck_since IS NOT NULL;

-- Catalog: estado de la reserva asociada (reservation_id del intento)
SELECT id, status, expires_at, confirmed_at, released_at
  FROM catalog.stock_reservations WHERE id = '<reservation_id>';
```

## Resolución según el caso

| `state` / `pointOfNoReturn`        | Error                   | Acción segura                                                                                                                                                                             |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STARTED` o `RESERVED` / `unknown` | `INVENTORY_UNAVAILABLE` | Restablecer Catalog o la red interna. El reconciliador libera la reserva `PENDING` (compensación) o, si Catalog ya la confirmó, completa el pedido. Ninguna acción manual sobre los datos |
| `CONFIRMED` / `yes`                | `PERSISTENCE_ERROR`     | Corregir la causa en la base de Commerce (conectividad, espacio, migración, restricción). El siguiente ciclo crea el pedido una sola vez                                                  |
| Cualquiera                         | `RESERVATION_MISMATCH`  | Las líneas confirmadas por Catalog no coinciden con el intento. Escalar al responsable de backend y conservar ambos registros como evidencia. **No liberar la reserva**                   |
| Cualquiera                         | `UNEXPECTED_ERROR`      | Revisar los logs con el `requestId`/`attemptId` y escalar                                                                                                                                 |

Para no esperar el backoff (tope: 15 min) una vez corregida la causa, se puede adelantar el próximo reintento sin cambiar el estado de la saga:

```sql
UPDATE commerce.checkout_attempts SET next_recovery_at = now() WHERE id = '<attempt_id>';
```

## Reconocimiento de entrega atascado (DT-08, M06.0)

Después de crear el pedido (C3), Commerce confirma a Catalog que la reserva corresponde a ese pedido: `POST /internal/catalog/stock-reservations/{id}/fulfill` (`CONFIRMED → FULFILLED`). `FULFILLED` es un reconocimiento técnico, no una entrega física. Si falla, **el pedido se conserva, el stock sigue descontado una sola vez y nada se libera**. `InventoryFulfillmentRecoveryService` reintenta con backoff (15 s, 30 s, 60 s… hasta 15 min) al arrancar y cada `FULFILLMENT_RECOVERY_INTERVAL_MS` (15 s).

| Señal                                                         | Dónde                                    | Significado                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_fulfillment_deferred`                              | Log de advertencia de `commerce-service` | Reintento programado; `errorCode` en lista blanca y `retryInMs`                                                                                                      |
| `inventory_fulfillment_stuck` / `INVENTORY_FULFILLMENT_STUCK` | Log de error y outbox de Commerce        | Al menos `FULFILLMENT_STUCK_ATTEMPTS` fallos (5), pedido más antiguo que `FULFILLMENT_STUCK_AGE_MS` (5 min) o conflicto semántico. Una sola alerta por intento       |
| `inventory_fulfillment_metrics`                               | Log de cada ciclo (error si `stuck > 0`) | `pending`, `stuck`, antigüedad del pedido pendiente más antiguo y reintentos máximos                                                                                 |
| `INVENTORY_FULFILLMENT_RECOVERED`                             | Outbox de Commerce                       | Un reconocimiento atascado terminó                                                                                                                                   |
| `stock_reservation_unfulfilled`                               | Log de advertencia de `catalog-service`  | Reservas `CONFIRMED` sin reconocimiento más antiguas que `RESERVATION_UNFULFILLED_AGE_SECONDS` (300 s); detecta el caso de **Commerce no recuperable**. Solo informa |

`fulfillment_last_error` toma uno de estos valores: `INVENTORY_UNAVAILABLE`, `INVALID_RESPONSE`, `RESERVATION_STATE_CONFLICT`, `ORDER_RESERVATION_MISMATCH` o `UNEXPECTED_ERROR`.

```sql
-- Commerce: pedidos sin reconocimiento de Catalog
SELECT a.id, a.order_id, a.reservation_id, a.fulfillment_attempts, a.fulfillment_last_error,
       a.fulfillment_next_attempt_at, a.fulfillment_stuck_since
  FROM commerce.checkout_attempts a
 WHERE a.state = 'COMPLETED' AND a.inventory_fulfilled_at IS NULL;
```

El reporte de Catalog se consulta en el listener interno (no publicado), con el token de inventario: `GET /internal/catalog/stock-reservations/unfulfilled?olderThanSeconds=300&limit=100`. Solo devuelve identificadores, fechas y antigüedad.

| Caso                                                        | Acción segura                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVENTORY_UNAVAILABLE` / `INVALID_RESPONSE`                | Restablecer Catalog o la red interna; el reconciliador converge solo (si Catalog ya lo había aplicado responde 200). Para no esperar el backoff: `UPDATE commerce.checkout_attempts SET fulfillment_next_attempt_at = now() WHERE id = '<attempt_id>';` |
| `ORDER_RESERVATION_MISMATCH` / `RESERVATION_STATE_CONFLICT` | La reserva está vinculada a otro pedido, no está confirmada o no existe. Escalar al responsable de backend y conservar ambos registros como evidencia. **No liberar ni modificar la reserva**                                                           |
| Reserva en el reporte de Catalog sin intento en Commerce    | Commerce perdió sus datos. Conciliar con el respaldo de Commerce. Cualquier reposición de stock debe hacerla un administrador como ajuste de inventario auditado (`STOCK_ADJUSTED`, M06), con la conciliación documentada                               |

## Casos fuera de este runbook

- **Commerce perdió sus datos o no puede recuperarse:** DT-08 detecta el caso (reporte y métrica `stock_reservation_unfulfilled` de Catalog), pero la resolución es manual. No existe reposición automática de reservas confirmadas y R27 permanece abierto.
- Las alarmas cloud (CloudWatch) se configuran en la Fase 5 (CTL-29).
