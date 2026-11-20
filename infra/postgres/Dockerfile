# DT-09 / AWS-03: imagen de operaciones de base de datos («db-ops»).
#
# Contiene psql y los scripts de aprovisionamiento, de modo que los jobs `postgres-provision` y
# `postgres-finalize` no dependen de montar archivos del host. Es la misma imagen que se publica en
# Amazon ECR y se ejecuta con `aws ecs run-task` (Fargate no admite bind mounts del host). No contiene
# credenciales: el administrador (PGUSER/PGPASSWORD) y las contraseñas de los roles llegan por variables
# de entorno.
FROM postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef

COPY provision-service-roles.sql finalize-service-roles.sql rollback-service-roles.sql /provision/
RUN chmod 0755 /provision && chmod 0444 /provision/*.sql

USER postgres
# Sin el entrypoint del servidor: esta imagen solo ejecuta el cliente psql.
ENTRYPOINT []
CMD ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/provision/provision-service-roles.sql"]
