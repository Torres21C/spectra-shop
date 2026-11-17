-- DT-09 / M07 mínimo: permisos del rol de ejecución de audit-service.
-- Lo aplica spectra_audit_migrator (propietario del esquema) después de `prisma migrate deploy`.
-- Solo anexar (RN-31): INSERT y SELECT; nunca UPDATE, DELETE ni TRUNCATE.
REVOKE ALL ON ALL TABLES IN SCHEMA "audit" FROM "spectra_audit_app";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "audit" FROM "spectra_audit_app";

GRANT SELECT, INSERT ON "audit"."audit_events" TO "spectra_audit_app";
