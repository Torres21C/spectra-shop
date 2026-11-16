-- M04 Checkout: reservas de inventario propiedad de catalog-service.
-- Commerce nunca escribe en este esquema; usa la API interna autenticada.

CREATE TYPE "catalog"."ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'RELEASED');

CREATE TABLE "catalog"."stock_reservations" (
    "id" UUID NOT NULL,
    "caller" VARCHAR(32) NOT NULL,
    "status" "catalog"."ReservationStatus" NOT NULL,
    "request_hash" CHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "release_reason" VARCHAR(32),
    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_reservations_state_check" CHECK (
      ("status" = 'PENDING' AND "confirmed_at" IS NULL AND "released_at" IS NULL)
      OR ("status" = 'CONFIRMED' AND "confirmed_at" IS NOT NULL AND "released_at" IS NULL)
      OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "confirmed_at" IS NULL)
    )
);

CREATE TABLE "catalog"."stock_reservation_lines" (
    "reservation_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "product_name" VARCHAR(150) NOT NULL,
    CONSTRAINT "stock_reservation_lines_pkey" PRIMARY KEY ("reservation_id", "product_id"),
    CONSTRAINT "stock_reservation_lines_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10),
    CONSTRAINT "stock_reservation_lines_price_check" CHECK ("unit_price" > 0)
);

CREATE INDEX "stock_reservations_status_expires_at_idx"
  ON "catalog"."stock_reservations"("status", "expires_at");
CREATE INDEX "stock_reservation_lines_product_id_idx"
  ON "catalog"."stock_reservation_lines"("product_id");

ALTER TABLE "catalog"."stock_reservation_lines"
  ADD CONSTRAINT "stock_reservation_lines_reservation_id_fkey" FOREIGN KEY ("reservation_id")
  REFERENCES "catalog"."stock_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalog"."stock_reservation_lines"
  ADD CONSTRAINT "stock_reservation_lines_product_id_fkey" FOREIGN KEY ("product_id")
  REFERENCES "catalog"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
