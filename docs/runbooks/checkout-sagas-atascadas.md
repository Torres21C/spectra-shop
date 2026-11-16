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

## Casos fuera de este runbook

- **Commerce perdió sus datos o no puede recuperarse** con reservas `CONFIRMED` sin intento: no existe todavía un protocolo automático (DT-08: confirmación de entrega FULFILLED y reporte de reservas confirmadas sin entrega, antes de M06). Cualquier reposición de stock debe hacerla un administrador como ajuste de inventario auditado (`STOCK_ADJUSTED`, M06), con la conciliación documentada.
- Las alarmas cloud (CloudWatch) se configuran en la Fase 5 (CTL-29).
