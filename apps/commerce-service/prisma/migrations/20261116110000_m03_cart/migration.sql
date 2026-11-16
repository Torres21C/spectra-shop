CREATE SCHEMA IF NOT EXISTS "commerce";

CREATE TYPE "commerce"."CartStatus" AS ENUM ('ACTIVO', 'CONVERTIDO');

CREATE TABLE "commerce"."carts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "commerce"."CartStatus" NOT NULL DEFAULT 'ACTIVO',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commerce"."cart_items" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cart_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10)
);

CREATE INDEX "carts_user_id_status_idx" ON "commerce"."carts"("user_id", "status");
CREATE UNIQUE INDEX "carts_one_active_per_user_idx"
  ON "commerce"."carts"("user_id") WHERE "status" = 'ACTIVO';
CREATE INDEX "cart_items_product_id_idx" ON "commerce"."cart_items"("product_id");
CREATE UNIQUE INDEX "cart_items_cart_id_product_id_key"
  ON "commerce"."cart_items"("cart_id", "product_id");
ALTER TABLE "commerce"."cart_items"
  ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id")
  REFERENCES "commerce"."carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
