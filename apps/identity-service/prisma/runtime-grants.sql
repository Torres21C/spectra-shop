-- DT-09 (M06.0): permisos mínimos del rol de ejecución de Identity.
-- Lo aplica spectra_identity_migrator (propietario del esquema) después de `prisma migrate deploy`.
-- Idempotente: revoca todo y vuelve a conceder la matriz explícita. Una migración que añada tablas
-- o necesite nuevas operaciones debe ampliar este archivo en el mismo cambio.
REVOKE ALL ON ALL TABLES IN SCHEMA "identity" FROM "spectra_identity_app";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "identity" FROM "spectra_identity_app";

GRANT SELECT ON "identity"."roles" TO "spectra_identity_app";
GRANT SELECT, INSERT, UPDATE ON "identity"."users" TO "spectra_identity_app";
GRANT SELECT, INSERT, UPDATE ON "identity"."auth_sessions" TO "spectra_identity_app";
GRANT SELECT, INSERT, UPDATE ON "identity"."refresh_tokens" TO "spectra_identity_app";
GRANT SELECT, INSERT ON "identity"."outbox_events" TO "spectra_identity_app";
