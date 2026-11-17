-- M06/M07 mínimo: outbox transaccional de Catalog (aditiva; no modifica datos existentes).
CREATE TABLE "catalog"."outbox_events" (
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
  ON "catalog"."outbox_events"("published_at", "occurred_at");
