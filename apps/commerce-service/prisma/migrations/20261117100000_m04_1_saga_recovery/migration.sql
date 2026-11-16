-- M04.1: recuperación observable de la saga de checkout (DT-01, aprobado C-04).
-- Backoff acotado, último error en lista blanca y marca de saga atascada para alertar una sola vez.

ALTER TABLE "commerce"."checkout_attempts"
    ADD COLUMN "next_recovery_at" TIMESTAMPTZ(3),
    ADD COLUMN "last_recovery_error" VARCHAR(40),
    ADD COLUMN "stuck_since" TIMESTAMPTZ(3),
    ADD CONSTRAINT "checkout_attempts_recovery_error_check" CHECK (
      "last_recovery_error" IS NULL OR "last_recovery_error" IN
        ('INVENTORY_UNAVAILABLE', 'RESERVATION_MISMATCH', 'PERSISTENCE_ERROR', 'UNEXPECTED_ERROR')
    );

CREATE INDEX "checkout_attempts_state_next_recovery_at_idx"
  ON "commerce"."checkout_attempts"("state", "next_recovery_at");
