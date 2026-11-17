-- DT-09 (M06.0): reversión del aprovisionamiento de roles por servicio.
--
-- Devuelve la propiedad de los esquemas `identity`, `catalog` y `commerce` y de todos sus objetos al
-- rol indicado en SPECTRA_ROLLBACK_OWNER (el propietario anterior; en desarrollo, POSTGRES_USER),
-- retira todos los privilegios concedidos a los seis roles de servicio, los elimina y restablece
-- CONNECT/TEMP de PUBLIC sobre la base. No modifica datos.
--
-- Requisitos: ejecutar como administrador del clúster, con los servicios detenidos y después de volver
-- a una configuración de Compose que conecte los servicios con SPECTRA_ROLLBACK_OWNER. Si el clúster
-- tiene otras bases donde estos roles posean objetos, repetir REASSIGN/DROP OWNED en cada una antes de
-- DROP ROLE. Procedimiento completo: docs/runbooks/dt09-roles-postgresql.md.

\set ON_ERROR_STOP on
\set QUIET on

\getenv rollback_owner SPECTRA_ROLLBACK_OWNER
\if :{?rollback_owner}
\else
  \echo 'DT-09 rollback: defina SPECTRA_ROLLBACK_OWNER con el propietario anterior'
  SELECT 1 / 0 AS missing_rollback_owner;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rollback_owner') AS owner_exists \gset
\if :owner_exists
\else
  \echo 'DT-09 rollback: SPECTRA_ROLLBACK_OWNER no existe'
  SELECT 1 / 0 AS unknown_rollback_owner;
\endif

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('spectra.dt09.provision'));

CREATE TEMP TABLE dt09_roles ON COMMIT DROP AS
SELECT rolname FROM pg_roles
 WHERE rolname IN ('spectra_identity_migrator', 'spectra_identity_app',
                   'spectra_catalog_migrator', 'spectra_catalog_app',
                   'spectra_commerce_migrator', 'spectra_commerce_app');

-- Propiedad de vuelta al propietario anterior (esquemas, tablas, secuencias, tipos y funciones).
SELECT format('REASSIGN OWNED BY %I TO %I', rolname, :'rollback_owner')
  FROM dt09_roles WHERE rolname LIKE '%\_migrator' \gexec

-- Privilegios concedidos a los roles de servicio y sus DEFAULT PRIVILEGES.
SELECT format('DROP OWNED BY %I', rolname) FROM dt09_roles \gexec

-- Valores por defecto de PostgreSQL para PUBLIC sobre la base.
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', current_database()) \gexec

COMMIT;

SELECT format('DROP ROLE %I', rolname)
  FROM pg_roles
 WHERE rolname IN ('spectra_identity_migrator', 'spectra_identity_app',
                   'spectra_catalog_migrator', 'spectra_catalog_app',
                   'spectra_commerce_migrator', 'spectra_commerce_app') \gexec

\echo 'DT-09 rollback: propiedad devuelta y roles de servicio eliminados'
