-- M04 Checkout: saga orquestada por commerce-service con transacciones ACID locales.
-- Sin columnas de tarjeta (RN-14, CA-M04-05). Sin FK hacia esquemas de otros servicios.

CREATE TYPE "commerce"."CheckoutState" AS ENUM
  ('STARTED', 'RESERVED', 'CONFIRMED', 'COMPLETED', 'REJECTED', 'FAILED', 'ABORTED');
CREATE TYPE "commerce"."OrderStatus" AS ENUM
  ('PAGADO', 'EN_PREPARACION', 'ENVIADO', 'ENTREGADO', 'CANCELADO');
CREATE TYPE "commerce"."SimulatedPaymentResult" AS ENUM ('APROBADO', 'RECHAZADO');

CREATE SEQUENCE "commerce"."order_number_seq" START WITH 10001 INCREMENT BY 1 NO CYCLE;

CREATE TABLE "commerce"."checkout_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "cart_fingerprint" CHAR(64) NOT NULL,
    "state" "commerce"."CheckoutState" NOT NULL,
    "reservation_id" UUID NOT NULL,
    "lease_owner" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "payment_result" "commerce"."SimulatedPaymentResult" NOT NULL,
    "lines" JSONB NOT NULL,
    "priced_lines" JSONB,
    "shipping" JSONB,
    "failure_code" VARCHAR(40),
    "failure_details" JSONB,
    "order_id" UUID,
    "recovery_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkout_attempts_completed_has_order_check"
      CHECK (("state" = 'COMPLETED') = ("order_id" IS NOT NULL)),
    CONSTRAINT "checkout_attempts_failure_code_check"
      CHECK ("state" NOT IN ('FAILED', 'REJECTED') OR "failure_code" IS NOT NULL),
    CONSTRAINT "checkout_attempts_recovery_check" CHECK ("recovery_attempts" >= 0)
);

CREATE UNIQUE INDEX "checkout_attempts_user_id_idempotency_key_key"
  ON "commerce"."checkout_attempts"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "checkout_attempts_reservation_id_key"
  ON "commerce"."checkout_attempts"("reservation_id");
CREATE UNIQUE INDEX "checkout_attempts_order_id_key"
  ON "commerce"."checkout_attempts"("order_id");
CREATE INDEX "checkout_attempts_state_lease_until_idx"
  ON "commerce"."checkout_attempts"("state", "lease_until");
CREATE INDEX "checkout_attempts_user_id_created_at_idx"
  ON "commerce"."checkout_attempts"("user_id", "created_at");
-- Un solo checkout en curso por carrito: impide comprar el mismo carrito con dos claves distintas.
CREATE UNIQUE INDEX "checkout_attempts_one_inflight_per_cart_idx"
  ON "commerce"."checkout_attempts"("cart_id")
  WHERE "state" IN ('STARTED', 'RESERVED', 'CONFIRMED');

CREATE TABLE "commerce"."orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(20) NOT NULL
      DEFAULT ('SP-'::text || nextval('commerce.order_number_seq'::regclass)),
    "user_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "checkout_attempt_id" UUID NOT NULL,
    "status" "commerce"."OrderStatus" NOT NULL DEFAULT 'PAGADO',
    "total" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GTQ',
    "shipping_name" VARCHAR(80) NOT NULL,
    "shipping_phone" VARCHAR(9) NOT NULL,
    "shipping_department" VARCHAR(40) NOT NULL,
    "shipping_municipality" VARCHAR(60) NOT NULL,
    "shipping_address" VARCHAR(150) NOT NULL,
    "shipping_references" VARCHAR(200),
    "payment_reference" VARCHAR(32) NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orders_total_check" CHECK ("total" >= 0),
    CONSTRAINT "orders_currency_check" CHECK ("currency" = 'GTQ'),
    CONSTRAINT "orders_payment_reference_check" CHECK ("payment_reference" LIKE 'SIM-%')
);

CREATE UNIQUE INDEX "orders_order_number_key" ON "commerce"."orders"("order_number");
CREATE UNIQUE INDEX "orders_checkout_attempt_id_key" ON "commerce"."orders"("checkout_attempt_id");
CREATE UNIQUE INDEX "orders_payment_reference_key" ON "commerce"."orders"("payment_reference");
CREATE UNIQUE INDEX "orders_user_id_idempotency_key_key"
  ON "commerce"."orders"("user_id", "idempotency_key");
CREATE INDEX "orders_user_id_created_at_idx" ON "commerce"."orders"("user_id", "created_at");

CREATE TABLE "commerce"."order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(150) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10),
    CONSTRAINT "order_items_unit_price_check" CHECK ("unit_price" > 0),
    CONSTRAINT "order_items_line_total_check" CHECK ("line_total" = "unit_price" * "quantity")
);

CREATE UNIQUE INDEX "order_items_order_id_product_id_key"
  ON "commerce"."order_items"("order_id", "product_id");

CREATE TABLE "commerce"."outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "actor_role" VARCHAR(20),
    "resource_type" VARCHAR(40) NOT NULL,
    "resource_id" UUID,
    "source_ip" VARCHAR(64),
    "request_id" UUID,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_result_check" CHECK ("result" IN ('EXITO', 'FALLO', 'DENEGADO'))
);

CREATE INDEX "outbox_events_published_at_occurred_at_idx"
  ON "commerce"."outbox_events"("published_at", "occurred_at");

ALTER TABLE "commerce"."checkout_attempts"
  ADD CONSTRAINT "checkout_attempts_cart_id_fkey" FOREIGN KEY ("cart_id")
  REFERENCES "commerce"."carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commerce"."orders"
  ADD CONSTRAINT "orders_checkout_attempt_id_fkey" FOREIGN KEY ("checkout_attempt_id")
  REFERENCES "commerce"."checkout_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commerce"."order_items"
  ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id")
  REFERENCES "commerce"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
