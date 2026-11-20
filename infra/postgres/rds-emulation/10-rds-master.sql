-- AWS-02: emulación local del usuario maestro de Amazon RDS for PostgreSQL.
--
-- Solo para proyectos Compose desechables (ver compose.rds-emulation.yaml). Se ejecuta una vez, al
-- inicializar un volumen nuevo, como superusuario del contenedor (que hace el papel de `rdsadmin`).
-- Crea `rds_master` como en RDS: LOGIN con CREATEROLE y CREATEDB, sin SUPERUSER, REPLICATION ni
-- BYPASSRLS, miembro de un rol `rds_superuser` sin atributos y propietario de la base de la aplicación.

\set ON_ERROR_STOP on
\getenv rds_master_password RDS_MASTER_PASSWORD
\if :{?rds_master_password}
\else
  \echo 'Emulación RDS: defina RDS_MASTER_PASSWORD'
  SELECT 1 / 0 AS missing_rds_master_password;
\endif

CREATE ROLE rds_superuser NOLOGIN;
CREATE ROLE rds_master LOGIN CREATEROLE CREATEDB PASSWORD :'rds_master_password';
\unset rds_master_password
GRANT rds_superuser TO rds_master;
SELECT format('ALTER DATABASE %I OWNER TO rds_master', current_database()) \gexec
