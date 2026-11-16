-- DT-09 (M06.0): permisos mínimos del rol de ejecución de Catalog.
-- Lo aplica spectra_catalog_migrator (propietario del esquema) después de `prisma migrate deploy`.
-- Idempotente: revoca todo y vuelve a conceder la matriz explícita. Una migración que añada tablas
-- o necesite nuevas operaciones (p. ej. la administración de M06) debe ampliar este archivo.
REVOKE ALL ON ALL TABLES IN SCHEMA "catalog" FROM "spectra_catalog_app";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "catalog" FROM "spectra_catalog_app";

GRANT SELECT ON "catalog"."categories" TO "spectra_catalog_app";
GRANT SELECT ON "catalog"."products" TO "spectra_catalog_app";
-- La reserva y su compensación solo modifican el stock y la marca de actualización.
GRANT UPDATE ("stock", "updated_at") ON "catalog"."products" TO "spectra_catalog_app";
GRANT SELECT, INSERT, UPDATE ON "catalog"."stock_reservations" TO "spectra_catalog_app";
GRANT SELECT, INSERT ON "catalog"."stock_reservation_lines" TO "spectra_catalog_app";
