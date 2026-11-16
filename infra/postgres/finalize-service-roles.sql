-- DT-09 (M06.0): cierre de la ventana de migración.
--
-- Lo ejecuta el administrador del clúster después de que los tres jobs `*-migrate` terminen y antes
-- de arrancar los servicios. Revoca CREATE sobre la base a los migradores (concedido temporalmente
-- por `provision-service-roles.sql`) y comprueba que en reposo ningún rol de servicio conserve
-- privilegios de base distintos de CONNECT. Es idempotente.

\set ON_ERROR_STOP on
\set QUIET on

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('spectra.dt09.provision'));

SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), r)
  FROM unnest(ARRAY[
    'spectra_identity_migrator', 'spectra_catalog_migrator', 'spectra_commerce_migrator'
  ]) AS r \gexec

SELECT count(*) = 0 AS closed
  FROM unnest(ARRAY[
    'spectra_identity_migrator', 'spectra_identity_app',
    'spectra_catalog_migrator', 'spectra_catalog_app',
    'spectra_commerce_migrator', 'spectra_commerce_app'
  ]) AS r
 WHERE has_database_privilege(r, current_database(), 'CREATE')
    OR has_database_privilege(r, current_database(), 'TEMP') \gset
\if :closed
\else
  \echo 'DT-09: un rol de servicio conserva CREATE o TEMP sobre la base'
  SELECT 1 / 0 AS migration_window_still_open;
\endif

COMMIT;

\echo 'DT-09: ventana de migración cerrada'
