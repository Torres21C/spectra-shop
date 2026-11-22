# DT-09 / AWS-03: imagen de operaciones de base de datos («db-ops»).
#
# Contiene psql y los scripts de aprovisionamiento, de modo que los jobs `postgres-provision` y
# `postgres-finalize` no dependen de montar archivos del host. Es la misma imagen que se publica en
# Amazon ECR y se ejecuta con `aws ecs run-task` (Fargate no admite bind mounts del host). No contiene
# credenciales: el administrador (PGUSER/PGPASSWORD) y las contraseñas de los roles llegan por variables
# de entorno.
# R-PR6-10: imagen mínima. Antes se usaba la imagen del servidor postgres:16.6-alpine (Alpine 3.21 fuera de
# soporte, con el servidor y gosu, que esta imagen no usa). Ahora solo lleva el cliente de PostgreSQL 16, la misma
# versión mayor que el servidor (Compose 16.x y RDS 16). Los certificados de CA del sistema vienen en la base
# (ca-certificates-bundle). Mismo usuario sin privilegios que antes: postgres (uid/gid 70).
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

# postgresql-common (dependencia del cliente) crea el usuario postgres con uid/gid 70, igual que la imagen del
# servidor; se comprueba para que el build falle si cambiara.
RUN apk add --no-cache postgresql16-client \
  && [ "$(id -u postgres):$(id -g postgres)" = "70:70" ]

COPY provision-service-roles.sql finalize-service-roles.sql rollback-service-roles.sql /provision/
RUN chmod 0755 /provision && chmod 0444 /provision/*.sql

USER postgres
# Esta imagen solo ejecuta el cliente psql.
ENTRYPOINT []
CMD ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/provision/provision-service-roles.sql"]
