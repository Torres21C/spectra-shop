-- DT-09 (M06.0): roles PostgreSQL separados por servicio, de migración y de ejecución.
--
-- Lo ejecuta el administrador del clúster, nunca un servicio. Es idempotente: puede repetirse sobre
-- un volumen nuevo o sobre uno existente sin borrar ni recrear datos.
--
--   * Crea, si no existen, los ocho roles LOGIN sin SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS
--     y rota sus contraseñas desde variables de entorno (nunca desde argumentos ni desde el repositorio).
--   * Retira CONNECT/TEMP de PUBLIC sobre la base y concede CONNECT solo a los ocho roles.
--   * Crea los esquemas si faltan y transfiere al migrador de cada servicio la propiedad del esquema
--     y de todos sus objetos (tablas, secuencias, tipos y funciones), incluida `_prisma_migrations`.
--   * Abre la ventana de migración: CREATE sobre la base solo para los migradores, hasta que
--     `finalize-service-roles.sql` la cierre.
--   * Revoca los privilegios de PUBLIC y de los roles de ejecución sobre los esquemas; cada runtime
--     recibe solo USAGE sobre su esquema. Los permisos sobre tablas los concede después el migrador
--     correspondiente (`apps/<servicio>/prisma/runtime-grants.sql`), una vez aplicadas sus migraciones.
--
-- Dos modos, según quién lo ejecute (AWS-02):
--   * Superusuario (POSTGRES_USER del contenedor local): comportamiento original de DT-09.
--   * Administrador delegado sin SUPERUSER (usuario maestro de Amazon RDS, miembro de rds_superuser):
--     debe tener CREATEROLE y CREATEDB y ser propietario de la base. PostgreSQL 16 no le permite fijar
--     parámetros de registro ni mencionar SUPERUSER/REPLICATION/BYPASSRLS en ALTER ROLE, y le concede
--     automáticamente ADMIN OPTION (sin INHERIT ni SET) sobre los roles que crea. Para transferir la
--     propiedad de los esquemas, el script se concede temporalmente INHERIT y SET sobre los migradores
--     dentro de la misma transacción y los revoca antes de confirmar. Exige además que el servidor no
--     registre sentencias (`log_statement = none`, `log_min_duration_statement = -1`), porque ALTER ROLE
--     transporta las contraseñas.
--
-- Variables de entorno obligatorias (solo hexadecimal, para poder usarlas en URLs sin escapar):
--   SPECTRA_IDENTITY_MIGRATOR_PASSWORD  SPECTRA_IDENTITY_APP_PASSWORD
--   SPECTRA_CATALOG_MIGRATOR_PASSWORD   SPECTRA_CATALOG_APP_PASSWORD
--   SPECTRA_COMMERCE_MIGRATOR_PASSWORD  SPECTRA_COMMERCE_APP_PASSWORD
--   SPECTRA_AUDIT_MIGRATOR_PASSWORD     SPECTRA_AUDIT_APP_PASSWORD   (M07 mínimo: audit-service)

\set ON_ERROR_STOP on
\set QUIET on

SET client_min_messages = 'warning';

SELECT rolsuper AS provisioner_is_superuser FROM pg_roles WHERE rolname = current_user \gset
\if :provisioner_is_superuser
  -- Las contraseñas no deben llegar al registro del servidor, ni siquiera ante un error.
  SET log_statement = 'none';
  SET log_min_error_statement = 'panic';
  SET log_min_duration_statement = -1;
\else
  -- Administrador delegado (RDS): no puede cambiar el registro de su sesión; se comprueba el del servidor.
  SELECT current_setting('log_statement') = 'none'
         AND current_setting('log_min_duration_statement') = '-1' AS server_logging_safe \gset
  \if :server_logging_safe
  \else
    \echo 'DT-09: el servidor registra sentencias; fije log_statement = none y log_min_duration_statement = -1 (parameter group)'
    SELECT 1 / 0 AS statement_logging_would_expose_passwords;
  \endif
  SELECT r.rolcreaterole AND r.rolcreatedb AND d.datdba = r.oid AS delegated_admin_ok
    FROM pg_roles r, pg_database d
   WHERE r.rolname = current_user AND d.datname = current_database() \gset
  \if :delegated_admin_ok
  \else
    \echo 'DT-09: el administrador delegado necesita CREATEROLE, CREATEDB y ser propietario de la base'
    SELECT 1 / 0 AS delegated_admin_missing_privileges;
  \endif
\endif

\getenv identity_migrator_password SPECTRA_IDENTITY_MIGRATOR_PASSWORD
\getenv identity_app_password SPECTRA_IDENTITY_APP_PASSWORD
\getenv catalog_migrator_password SPECTRA_CATALOG_MIGRATOR_PASSWORD
\getenv catalog_app_password SPECTRA_CATALOG_APP_PASSWORD
\getenv commerce_migrator_password SPECTRA_COMMERCE_MIGRATOR_PASSWORD
\getenv commerce_app_password SPECTRA_COMMERCE_APP_PASSWORD
\getenv audit_migrator_password SPECTRA_AUDIT_MIGRATOR_PASSWORD
\getenv audit_app_password SPECTRA_AUDIT_APP_PASSWORD

SELECT (
  :{?identity_migrator_password} AND :{?identity_app_password}
  AND :{?catalog_migrator_password} AND :{?catalog_app_password}
  AND :{?commerce_migrator_password} AND :{?commerce_app_password}
  AND :{?audit_migrator_password} AND :{?audit_app_password}
) AS all_defined \gset
\if :all_defined
\else
  \echo 'DT-09: faltan contraseñas SPECTRA_*_PASSWORD en el entorno'
  SELECT 1 / 0 AS missing_service_role_password;
\endif

-- Se valida el formato sin mostrar los valores.
SELECT bool_and(v ~ '^[0-9a-f]{32,128}$') AS passwords_ok
  FROM unnest(ARRAY[
    :'identity_migrator_password', :'identity_app_password',
    :'catalog_migrator_password', :'catalog_app_password',
    :'commerce_migrator_password', :'commerce_app_password',
    :'audit_migrator_password', :'audit_app_password'
  ]) AS v \gset
\if :passwords_ok
\else
  \echo 'DT-09: las contraseñas deben ser hexadecimales de 32 a 128 caracteres (openssl rand -hex 32)'
  SELECT 1 / 0 AS invalid_service_role_password;
\endif

SELECT (SELECT count(DISTINCT v) FROM unnest(ARRAY[
    :'identity_migrator_password', :'identity_app_password',
    :'catalog_migrator_password', :'catalog_app_password',
    :'commerce_migrator_password', :'commerce_app_password',
    :'audit_migrator_password', :'audit_app_password'
  ]) AS v) = 8 AS passwords_distinct \gset
\if :passwords_distinct
\else
  \echo 'DT-09: cada rol necesita una contraseña distinta'
  SELECT 1 / 0 AS duplicated_service_role_password;
\endif

-- Atributos de los roles. Un administrador delegado no puede mencionar SUPERUSER, REPLICATION ni
-- BYPASSRLS (tampoco puede concederlos); su ausencia se comprueba explícitamente tras ALTER ROLE.
\if :provisioner_is_superuser
  \set role_attributes 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT -1'
\else
  \set role_attributes 'LOGIN NOCREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT -1'
\endif

BEGIN;

-- Serializa ejecuciones concurrentes del aprovisionamiento.
SELECT pg_advisory_xact_lock(hashtext('spectra.dt09.provision'));

-- 1. Roles ------------------------------------------------------------------------------------
SELECT format('CREATE ROLE %I', r)
  FROM unnest(ARRAY[
    'spectra_identity_migrator', 'spectra_identity_app',
    'spectra_catalog_migrator', 'spectra_catalog_app',
    'spectra_commerce_migrator', 'spectra_commerce_app',
    'spectra_audit_migrator', 'spectra_audit_app'
  ]) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE spectra_identity_migrator WITH :role_attributes PASSWORD :'identity_migrator_password';
ALTER ROLE spectra_identity_app      WITH :role_attributes PASSWORD :'identity_app_password';
ALTER ROLE spectra_catalog_migrator  WITH :role_attributes PASSWORD :'catalog_migrator_password';
ALTER ROLE spectra_catalog_app       WITH :role_attributes PASSWORD :'catalog_app_password';
ALTER ROLE spectra_commerce_migrator WITH :role_attributes PASSWORD :'commerce_migrator_password';
ALTER ROLE spectra_commerce_app      WITH :role_attributes PASSWORD :'commerce_app_password';
ALTER ROLE spectra_audit_migrator    WITH :role_attributes PASSWORD :'audit_migrator_password';
ALTER ROLE spectra_audit_app         WITH :role_attributes PASSWORD :'audit_app_password';

\unset identity_migrator_password
\unset identity_app_password
\unset catalog_migrator_password
\unset catalog_app_password
\unset commerce_migrator_password
\unset commerce_app_password
\unset audit_migrator_password
\unset audit_app_password

SELECT count(*) = 0 AS roles_unprivileged
  FROM pg_roles
 WHERE rolname ~ '^spectra_(identity|catalog|commerce|audit)_(migrator|app)$'
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin) \gset
\if :roles_unprivileged
\else
  \echo 'DT-09: un rol de servicio conserva un atributo elevado'
  SELECT 1 / 0 AS service_role_has_elevated_attribute;
\endif

-- Ningún rol de servicio puede ser miembro de otro (impide SET ROLE hacia un migrador o entre servicios).
-- Se excluyen las concesiones al propio administrador: en modo delegado PostgreSQL le otorga ADMIN
-- OPTION sobre los roles que crea, y retirarla le impediría rotar contraseñas.
SELECT format('REVOKE %I FROM %I CASCADE', r.rolname, m.rolname)
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE m.rolname <> current_user
   AND (r.rolname ~ '^spectra_(identity|catalog|commerce|audit)_(migrator|app)$'
        OR (m.rolname ~ '^spectra_(identity|catalog|commerce|audit)_(migrator|app)$' AND NOT r.rolname ~ '^pg_')) \gexec

CREATE TEMP TABLE dt09_service (schema_name text PRIMARY KEY, migrator text NOT NULL, runtime text NOT NULL) ON COMMIT DROP;
INSERT INTO dt09_service VALUES
  ('identity', 'spectra_identity_migrator', 'spectra_identity_app'),
  ('catalog',  'spectra_catalog_migrator',  'spectra_catalog_app'),
  ('commerce', 'spectra_commerce_migrator', 'spectra_commerce_app'),
  ('audit',    'spectra_audit_migrator',    'spectra_audit_app');

\if :provisioner_is_superuser
\else
  -- Delegación temporal: el administrador actúa como cada migrador (propietario de su esquema) solo
  -- dentro de esta transacción. Se revoca en el paso 6; si algo falla, el ROLLBACK la descarta.
  SELECT format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER', migrator)
    FROM dt09_service \gexec
\endif

-- 2. Base de datos ----------------------------------------------------------------------------
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r)
  FROM unnest(ARRAY[
    'spectra_identity_migrator', 'spectra_identity_app',
    'spectra_catalog_migrator', 'spectra_catalog_app',
    'spectra_commerce_migrator', 'spectra_commerce_app',
    'spectra_audit_migrator', 'spectra_audit_app'
  ]) AS r \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r)
  FROM unnest(ARRAY[
    'spectra_identity_migrator', 'spectra_identity_app',
    'spectra_catalog_migrator', 'spectra_catalog_app',
    'spectra_commerce_migrator', 'spectra_commerce_app',
    'spectra_audit_migrator', 'spectra_audit_app'
  ]) AS r \gexec

-- Ningún rol de servicio crea objetos en `public`.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Esquemas y propiedad ---------------------------------------------------------------------
SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', schema_name, migrator) FROM dt09_service \gexec
SELECT format('ALTER SCHEMA %I OWNER TO %I', schema_name, migrator) FROM dt09_service \gexec

-- Tablas, vistas y tablas foráneas (los índices y las secuencias vinculadas siguen a su tabla).
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, s.migrator)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN dt09_service s ON s.schema_name = n.nspname
 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = s.migrator) \gexec

-- Secuencias independientes (p. ej. commerce.order_number_seq).
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, s.migrator)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN dt09_service s ON s.schema_name = n.nspname
 WHERE c.relkind = 'S'
   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = s.migrator)
   AND NOT EXISTS (
     SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')
   ) \gexec

-- Enums y dominios.
SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, s.migrator)
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN dt09_service s ON s.schema_name = n.nspname
 WHERE t.typtype IN ('e', 'd')
   AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = s.migrator) \gexec

-- Funciones y procedimientos.
SELECT format('ALTER ROUTINE %I.%I(%s) OWNER TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), s.migrator)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN dt09_service s ON s.schema_name = n.nspname
 WHERE p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = s.migrator) \gexec

-- 4. Privilegios de esquema -------------------------------------------------------------------
-- Se parte de cero en cada ejecución: ni PUBLIC ni ningún rol de servicio conserva privilegios heredados.
SELECT format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', schema_name) FROM dt09_service \gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM %I', s.schema_name, other.runtime)
  FROM dt09_service s CROSS JOIN dt09_service other \gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM %I', s.schema_name, other.migrator)
  FROM dt09_service s CROSS JOIN dt09_service other
 WHERE other.schema_name <> s.schema_name \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', schema_name) FROM dt09_service \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', schema_name) FROM dt09_service \gexec
SELECT format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', schema_name) FROM dt09_service \gexec

SELECT format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, runtime) FROM dt09_service \gexec

-- Las funciones que cree un migrador no serán ejecutables por PUBLIC.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', migrator)
  FROM dt09_service \gexec

-- 5. Ventana de migración ---------------------------------------------------------------------
-- Las migraciones históricas M01 y M03 ejecutan `CREATE SCHEMA IF NOT EXISTS`, y PostgreSQL exige
-- CREATE sobre la base antes de comprobar si el esquema ya existe. Los migradores reciben ese
-- privilegio solo durante la ventana de migración; `finalize-service-roles.sql` lo revoca antes de
-- que arranque cualquier servicio. Los roles de ejecución nunca lo reciben.
SELECT format('GRANT CREATE ON DATABASE %I TO %I', current_database(), migrator) FROM dt09_service \gexec

-- 6. Fin de la delegación temporal ----------------------------------------------------------------
\if :provisioner_is_superuser
\else
  SELECT format('REVOKE %I FROM CURRENT_USER GRANTED BY CURRENT_USER', migrator) FROM dt09_service \gexec
\endif

-- El administrador solo puede conservar ADMIN OPTION (gestionar el rol), nunca usar sus privilegios.
SELECT count(*) = 0 AS no_delegation_left
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
 WHERE r.rolname ~ '^spectra_(identity|catalog|commerce|audit)_(migrator|app)$'
   AND (am.inherit_option OR am.set_option) \gset
\if :no_delegation_left
\else
  \echo 'DT-09: queda una pertenencia con INHERIT o SET sobre un rol de servicio'
  SELECT 1 / 0 AS service_role_delegation_left;
\endif

COMMIT;

\echo 'DT-09: aprovisionamiento de roles completado'
