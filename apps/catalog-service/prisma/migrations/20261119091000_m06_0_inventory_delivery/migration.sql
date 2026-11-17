-- DT-08 (M06.0): confirmación de entrega (FULFILLED) de reservas de inventario.
-- Commerce reconoce cada reserva CONFIRMED con su pedido. La vinculación reserva–pedido es única
-- en ambos sentidos. No existe ninguna transición desde CONFIRMED o FULFILLED hacia RELEASED.

ALTER TABLE "catalog"."stock_reservations"
    ADD COLUMN "order_id" UUID,
    ADD COLUMN "fulfilled_at" TIMESTAMPTZ(3),
    ADD COLUMN "restocked_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "stock_reservations_order_id_key"
  ON "catalog"."stock_reservations"("order_id");
-- Reporte de reservas confirmadas sin reconocimiento, ordenadas por antigüedad.
CREATE INDEX "stock_reservations_status_confirmed_at_idx"
  ON "catalog"."stock_reservations"("status", "confirmed_at");

ALTER TABLE "catalog"."stock_reservations"
    DROP CONSTRAINT "stock_reservations_state_check",
    ADD CONSTRAINT "stock_reservations_state_check" CHECK (
      ("status" = 'PENDING' AND "confirmed_at" IS NULL AND "released_at" IS NULL
        AND "fulfilled_at" IS NULL AND "restocked_at" IS NULL AND "order_id" IS NULL)
      OR ("status" = 'CONFIRMED' AND "confirmed_at" IS NOT NULL AND "released_at" IS NULL
        AND "fulfilled_at" IS NULL AND "restocked_at" IS NULL AND "order_id" IS NULL)
      OR ("status" = 'FULFILLED' AND "confirmed_at" IS NOT NULL AND "released_at" IS NULL
        AND "fulfilled_at" IS NOT NULL AND "restocked_at" IS NULL AND "order_id" IS NOT NULL)
      OR ("status" = 'RESTOCKED' AND "confirmed_at" IS NOT NULL AND "released_at" IS NULL
        AND "fulfilled_at" IS NOT NULL AND "restocked_at" IS NOT NULL AND "order_id" IS NOT NULL)
      OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "confirmed_at" IS NULL
        AND "fulfilled_at" IS NULL AND "restocked_at" IS NULL AND "order_id" IS NULL)
    ),
    ADD CONSTRAINT "stock_reservations_delivery_chronology_check" CHECK (
      ("fulfilled_at" IS NULL OR "fulfilled_at" >= "confirmed_at")
      AND ("restocked_at" IS NULL OR "restocked_at" >= "fulfilled_at")
    );
