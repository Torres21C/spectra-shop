# ADR-AWS-01 — Aprovisionamiento DT-09 compatible con Amazon RDS

- **Estado:** propuesta (pendiente de aprobación del propietario). Implementada en la rama local `feature/aws-pr1-dt09-rds`.
- **Fecha:** 2026-11-20
- **Hallazgos:** AWS-02 (aprovisionamiento que exige superusuario) y AWS-03 (jobs de base de datos con bind mounts e imagen de Docker Hub) del [diagnóstico AWS](../operacion-y-aws/03-diagnostico-aws.md). Cierra el pendiente heredado **I-4** de M06.0 a nivel de diseño. Su validación en una instancia RDS real queda para la Fase 5.
- **Relacionado:** [ADR-M06-0-01](ADR-M06-0-01-roles-postgresql.md), [runbook DT-09](../runbooks/dt09-roles-postgresql.md).

## Contexto

`infra/postgres/provision-service-roles.sql` se diseñó para el superusuario del contenedor local. En Amazon RDS, el usuario maestro **no** es superusuario: pertenece a `rds_superuser` y tiene `CREATEROLE` y `CREATEDB`. Al ejecutar el script como un rol así en PostgreSQL 16.6, la primera instrucción falla (`permission denied to set parameter "log_statement"`). Aunque se superara ese punto, PostgreSQL 16 tampoco permite a un no superusuario:

- mencionar `SUPERUSER`, `REPLICATION` ni `BYPASSRLS` en `ALTER ROLE`;
- transferir la propiedad de un esquema a un rol hacia el que no puede hacer `SET ROLE`.

Además, al crear un rol, PostgreSQL concede automáticamente al creador `ADMIN OPTION` sobre él, sin `INHERIT` ni `SET`. El bloque que revocaba todas las pertenencias habría retirado esa concesión, y la matriz DT-09 exigía cero pertenencias.

Por otro lado, los jobs `postgres-provision` y `postgres-finalize` montaban los SQL desde el host y usaban la imagen `postgres` de Docker Hub. Ninguna de las dos cosas es viable en Fargate sin NAT.

## Decisiones

1. **D-AWS-01-01. Un único script con dos modos.** El script detecta si quien lo ejecuta es superusuario:
   - **Superusuario** (Compose local): comportamiento idéntico al anterior.
   - **Administrador delegado** (RDS): exige `CREATEROLE`, `CREATEDB` y la propiedad de la base. Comprueba que el servidor no registre sentencias (`log_statement = none` y `log_min_duration_statement = -1`), porque `ALTER ROLE` transporta las contraseñas. Además, omite los atributos que no puede mencionar.

   En ambos modos, tras `ALTER ROLE` se comprueba explícitamente que ningún rol de servicio tenga atributos elevados. Se descartó mantener dos scripts para evitar que diverjan.

2. **D-AWS-01-02. Delegación temporal y verificable.** En modo delegado, el administrador se concede `INHERIT` y `SET` sobre cada migrador (`GRANTED BY CURRENT_USER`) **dentro de la misma transacción**, transfiere las propiedades y lo revoca antes del `COMMIT`; ante cualquier error, el `ROLLBACK` lo descarta. El aprovisionamiento y `finalize-service-roles.sql` fallan si queda alguna pertenencia con `INHERIT` o `SET` sobre un rol de servicio.
3. **D-AWS-01-03. Única pertenencia admitida: `ADMIN OPTION` del administrador.** Permite gestionar el rol (rotar la contraseña) pero no usar sus privilegios. `scripts/verify-db-isolation.mjs` la admite solo si es exactamente `ADMIN` sin `INHERIT` ni `SET` y la informa como `adminOnlyGrantsToProvisioner`. Cualquier otra pertenencia sigue contando como fallo.
4. **D-AWS-01-04. Imagen `db-ops`.** `infra/postgres/Dockerfile` (base `postgres:16.6-alpine` fijada por digest, usuario `postgres`, sin el entrypoint del servidor) contiene los tres scripts. Compose la construye para `postgres-provision` y `postgres-finalize`, y es la misma imagen que se publicará en ECR y se ejecutará con `aws ecs run-task`.
5. **D-AWS-01-05. Emulación local de RDS.** `infra/postgres/rds-emulation/` crea, en un volumen nuevo, un `rds_master` con los atributos del maestro de RDS y propietario de la base, y hace que el aprovisionamiento y el cierre se ejecuten como él. Permite validar AWS-02 sin costo y sin cuenta AWS. Solo se usa en proyectos Compose desechables.

## Consecuencias

- Requisitos del parameter group de RDS: `log_statement = none`, `log_min_duration_statement = -1` y `rds.force_ssl = 1`. **Riesgo residual:** con el valor por defecto `log_min_error_statement = error`, si un `ALTER ROLE` fallara, su texto (con la contraseña) quedaría en el log de RDS. El script valida el formato de las contraseñas antes de usarlas para minimizarlo.
- `rollback-service-roles.sql` sigue exigiendo un superusuario (`REASSIGN OWNED`/`DROP OWNED` entre roles ajenos) y **no está adaptado a RDS**. En AWS, el rollback se hace restaurando un snapshot en una instancia nueva.
- La emulación reproduce los permisos de PostgreSQL 16 de un maestro no superusuario, pero no las particularidades propias de RDS (extensiones, `rdsadmin`, parameter groups). La validación definitiva es la prueba P7 del plan AWS en una instancia real.
