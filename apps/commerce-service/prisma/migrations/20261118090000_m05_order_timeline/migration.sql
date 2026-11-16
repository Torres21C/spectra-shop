-- M05 Gestión de pedidos: línea de tiempo mediante columnas de fecha por estado (D-M05-01, ERS §8.2 D-08).
-- Compatible con M04: los pedidos existentes están en PAGADO con `paid_at` y las columnas nuevas en NULL,
-- por lo que satisfacen ambas restricciones sin migrar datos.
-- Las transiciones (RN-24) las ejecutará M06; aquí la base de datos garantiza que el estado vigente
-- y su fecha sean coherentes, de modo que la fecha mostrada al cliente es la del último cambio (CA-M05-04).

ALTER TABLE "commerce"."orders"
    ADD COLUMN "preparing_at" TIMESTAMPTZ(3),
    ADD COLUMN "shipped_at" TIMESTAMPTZ(3),
    ADD COLUMN "delivered_at" TIMESTAMPTZ(3),
    ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
    -- Cada estado exige exactamente las fechas de los estados por los que pasó (RN-24).
    ADD CONSTRAINT "orders_timeline_status_check" CHECK (
      CASE "status"
        WHEN 'PAGADO' THEN "preparing_at" IS NULL AND "shipped_at" IS NULL
          AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
        WHEN 'EN_PREPARACION' THEN "preparing_at" IS NOT NULL AND "shipped_at" IS NULL
          AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
        WHEN 'ENVIADO' THEN "preparing_at" IS NOT NULL AND "shipped_at" IS NOT NULL
          AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
        WHEN 'ENTREGADO' THEN "preparing_at" IS NOT NULL AND "shipped_at" IS NOT NULL
          AND "delivered_at" IS NOT NULL AND "cancelled_at" IS NULL
        -- RN-24: solo PAGADO o EN_PREPARACION pueden cancelarse; nunca después de ENVIADO.
        WHEN 'CANCELADO' THEN "cancelled_at" IS NOT NULL AND "shipped_at" IS NULL
          AND "delivered_at" IS NULL
      END
    ),
    -- Orden cronológico de la línea de tiempo.
    ADD CONSTRAINT "orders_timeline_chronology_check" CHECK (
      ("preparing_at" IS NULL OR "preparing_at" >= "paid_at")
      AND ("shipped_at" IS NULL OR "shipped_at" >= "preparing_at")
      AND ("delivered_at" IS NULL OR "delivered_at" >= "shipped_at")
      AND ("cancelled_at" IS NULL OR "cancelled_at" >= COALESCE("preparing_at", "paid_at"))
    );

-- Historial paginado del propietario (RF-026): orden estable por fecha descendente con desempate por id.
DROP INDEX "commerce"."orders_user_id_created_at_idx";
CREATE INDEX "orders_user_id_created_at_id_idx"
  ON "commerce"."orders"("user_id", "created_at" DESC, "id" DESC);
