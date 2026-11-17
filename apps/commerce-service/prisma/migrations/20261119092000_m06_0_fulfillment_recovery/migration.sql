-- DT-08 (M06.0): seguimiento del reconocimiento de entrega (FULFILLED) de la reserva de inventario.
-- Después de C3, Commerce confirma a Catalog la reserva con su pedido. Si falla, el pedido se
-- conserva y un reconciliador reintenta con backoff; nunca se libera inventario.
-- Los intentos COMPLETED previos quedan con inventory_fulfilled_at NULL y el reconciliador los
-- reconoce después del despliegue.

ALTER TABLE "commerce"."checkout_attempts"
    ADD COLUMN "inventory_fulfilled_at" TIMESTAMPTZ(3),
    ADD COLUMN "fulfillment_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "fulfillment_next_attempt_at" TIMESTAMPTZ(3),
    ADD COLUMN "fulfillment_last_error" VARCHAR(40),
    ADD COLUMN "fulfillment_stuck_since" TIMESTAMPTZ(3),
    ADD COLUMN "fulfillment_lease_owner" UUID,
    ADD COLUMN "fulfillment_lease_until" TIMESTAMPTZ(3),
    ADD CONSTRAINT "checkout_attempts_fulfillment_state_check" CHECK (
      "inventory_fulfilled_at" IS NULL OR ("state" = 'COMPLETED' AND "order_id" IS NOT NULL)
    ),
    ADD CONSTRAINT "checkout_attempts_fulfillment_attempts_check" CHECK ("fulfillment_attempts" >= 0),
    ADD CONSTRAINT "checkout_attempts_fulfillment_error_check" CHECK (
      "fulfillment_last_error" IS NULL OR "fulfillment_last_error" IN
        ('INVENTORY_UNAVAILABLE', 'INVALID_RESPONSE', 'RESERVATION_STATE_CONFLICT',
         'ORDER_RESERVATION_MISMATCH', 'UNEXPECTED_ERROR')
    );

CREATE INDEX "checkout_attempts_fulfillment_pending_idx"
  ON "commerce"."checkout_attempts"("state", "inventory_fulfilled_at", "fulfillment_next_attempt_at");
