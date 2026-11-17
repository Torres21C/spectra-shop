-- M07 mínimo: registro de auditoría de solo anexar (RN-31). Aditiva.
CREATE TABLE "audit"."audit_events" (
    "id" UUID NOT NULL,
    "source_service" VARCHAR(20) NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "actor_role" VARCHAR(20),
    "resource_type" VARCHAR(40) NOT NULL,
    "resource_id" UUID,
    "source_ip" VARCHAR(64),
    "request_id" UUID,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_result_check" CHECK ("result" IN ('EXITO', 'FALLO', 'DENEGADO')),
    CONSTRAINT "audit_events_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE INDEX "audit_events_occurred_at_idx" ON "audit"."audit_events"("occurred_at");
