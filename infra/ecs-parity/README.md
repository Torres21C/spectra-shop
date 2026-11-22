# Paridad local de seguridad con ECS Fargate (PR-7A)

Comprueba, **sin AWS**, que los cuatro microservicios funcionan con las restricciones de ejecución que les impondrán sus task definitions en ECS Fargate (`infra/terraform/modules/ecs`): raíz de solo lectura, sin capacidades Linux, con proceso init, usuario no privilegiado, el mismo entorno y conexiones TLS a PostgreSQL. Cierra en local el riesgo R-PR5-10 («`readonlyRootFilesystem = true` no se ha probado con las imágenes reales»). La prueba P1 en AWS lo confirmará.

> [!WARNING]
> Usar solo con un proyecto Compose **nuevo y desechable** (`spectra-pr7a-<sufijo>`), nunca con el stack principal `spectra-shop`. El script no borra volúmenes; al terminar detiene el proyecto y deja contenedores y volúmenes para su revisión.

## Archivos

| Archivo                                        | Función                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `compose.ecs-parity.yaml`                      | Override que se aplica tras `compose.yaml` y la emulación de RDS (`infra/postgres/rds-emulation/compose.rds-emulation.yaml`)    |
| `../../scripts/ecs-parity/run-parity-tests.sh` | Genera credenciales y CA efímeras fuera del repositorio, levanta el proyecto y ejecuta las pruebas y la recogida de evidencias  |
| `../../scripts/ecs-parity/kms-seed.mjs`        | Crea la clave ECC_NIST_P256 de firma de JWT y su alias en el emulador de KMS (solo admite un endpoint local)                    |
| `../../scripts/ecs-parity/parity_checks.py`    | Compara la configuración renderizada con las task definitions, resume el smoke y DT-09 y redacta los secretos de las evidencias |

## Uso

Requisitos: Docker con Compose ≥ 2.24 (`!reset`/`!override`), Node 22+ en el host (smoke), `openssl`, `python3` y las imágenes `postgres:16.6-alpine` y `nsmithuk/local-kms:3.12.0` en local (el override fija sus digests y usa `pull_policy: never`).

1. Cargar las 9 imágenes `linux/amd64` de un artefacto `ecr-release-<sha>` de la CI, tras verificarlo:

   ```sh
   python3 scripts/ecr/release_tool.py verify-release --sha <sha> --expected-images-sha256 <sha256 de images.json> <dir>
   for t in <dir>/images/*.tar; do docker load -i "$t"; done
   # Etiquetar cada digest como <prefijo>/<nombre>:<etiqueta>, p. ej. spectra-pr7a/identity-service-runtime:<sha>
   ```

2. Ejecutar:

   ```sh
   SPECTRA_PARITY_PROJECT=spectra-pr7a-<sufijo> SPECTRA_PARITY_IMAGE_PREFIX=spectra-pr7a SPECTRA_PARITY_IMAGE_TAG=<etiqueta> \
     scripts/ecs-parity/run-parity-tests.sh <dir-de-trabajo> <dir-de-evidencias>
   ```

   Ambos directorios deben estar fuera del repositorio, y el de evidencias, vacío. Los puertos son `127.0.0.1:43001-43004` (`SPECTRA_PARITY_PORT_BASE`) y las subredes `10.233.71.0/24` y `10.233.72.0/24` (`SPECTRA_PARITY_EDGE_SUBNET`, `SPECTRA_PARITY_BACKEND_SUBNET`). Sale con 0 solo si todas las pruebas pasan. Resultado: `<dir-de-evidencias>/resultados.tsv`.

## Equivalencias con ECS

| Task definition (Terraform)                                    | Override local                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `readonlyRootFilesystem = true` (servicios)                    | `read_only: true`, **sin volúmenes ni tmpfs** (Fargate no admite `tmpfs`)        |
| `readonlyRootFilesystem = false` (tareas de operación)         | `read_only: false` en `postgres-provision`, `*-migrate` y `postgres-finalize`    |
| `linuxParameters.initProcessEnabled = true`                    | `init: true` (PID 1 = `docker-init`)                                             |
| `linuxParameters.capabilities.drop = ["ALL"]`                  | `cap_drop: [ALL]` en servicios y tareas                                          |
| Sin `user` en la task definition                               | Sin `user:`: usuario de la imagen (`node`, `postgres`)                           |
| `cpu_architecture = X86_64`                                    | `platform: linux/amd64` con las imágenes construidas por la CI                   |
| `healthCheck` 15 s / 5 s / 3 reintentos / 30 s, `GET /health`  | Mismos valores                                                                   |
| Variables y `secrets` de `workloads.tf`                        | Las mismas claves (lo comprueba `parity_checks.py check-config`)                 |
| URL DT-09: `…?schema=<svc>&sslmode=require&connection_limit=5` | Mismo formato                                                                    |
| Ops: `PGSSLMODE = require`, maestro de RDS no superusuario     | `PGSSLMODE=require`, `rds_master` de la emulación RDS (ADR-AWS-01)               |
| RDS `rds.force_ssl = 1` y `log_*` del parameter group          | PostgreSQL 16 con `ssl=on`, `hostnossl … reject`, TLS ≥ 1.2 y los mismos `log_*` |
| KMS (`kms:Sign`/`kms:GetPublicKey` con el rol de tarea)        | Emulador `local-kms` en la red interna; credenciales ficticias                   |
| Cloud Map (`identity.spectra.internal:3101`, …)                | Nombres de servicio de Compose (`identity-service:3101`, …)                      |
| `CORS_ORIGINS = https://<dominio CloudFront>`                  | `https://parity.spectra.test` (el smoke envía ese `Origin`)                      |

## Diferencias conocidas (no cubiertas por esta prueba)

- **No es Fargate.** El runtime es Docker Desktop con emulación amd64; el perfil seccomp, el kernel y `/dev/shm` pueden diferir. `/dev/shm` es un tmpfs que Docker monta siempre y es escribible incluso con `read_only`: se documenta como ruta escribible conocida.
- **`NoNewPrivs`** no se fuerza: la task definition de Fargate no tiene una opción equivalente (`dockerSecurityOptions` no existe en Fargate). La ausencia de capacidades (incluido el conjunto límite) y de binarios setuid/setgid son los controles que se verifican.
- **TLS:** los servicios usan `sslmode=require` (cifra, no verifica el certificado; C6/D-AWS-05-07). El verificador DT-09 (librería `pg`, que trata `require` como `verify-full`) verifica el certificado contra la CA de prueba. En AWS necesitará el bundle de CA de RDS (decisión 6.8).
- **Socket local de PostgreSQL** con `trust` solo dentro del contenedor de base de datos (inicialización y healthcheck), que en RDS no existe.
- **KMS emulado:** no valida IAM (`kms:SigningAlgorithm`, `kms:MessageType`) ni el endpoint de VPC; eso queda para AWS (C9).

## Health checks: contenedor, ALB y ECS (lo que esta prueba no demuestra)

En AWS intervienen dos comprobaciones distintas y el planificador de ECS:

| Mecanismo                                                | Ruta y parámetros (Terraform)                                                                                    | Efecto si falla                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| healthCheck del contenedor (`modules/ecs/main.tf`)       | `GET /health` (vida, no consulta la base de datos); 15 s / 5 s / 3 reintentos / 30 s de inicio                   | ECS marca el contenedor como no sano y reemplaza la tarea                                                                                                                                             |
| Target group del ALB (`modules/alb/main.tf`)             | `GET /health/ready` (`SELECT 1`, ADR-AWS-04); intervalo 15 s, `unhealthy_threshold = 3`, `healthy_threshold = 2` | El ALB deja de enviar tráfico al target. Si **todos** los targets del grupo están no sanos, el ALB los trata a todos como sanos y reparte el tráfico entre ellos (_fail-open_)                        |
| Servicio ECS con `load_balancer` (`modules/ecs/main.tf`) | `health_check_grace_period_seconds = 60`; circuit breaker solo durante despliegues                               | Pasado el período de gracia, ECS tiene en cuenta la salud que informa el ALB y **puede detener y reemplazar** las tareas que este marque como no sanas, aunque su healthCheck de contenedor siga sano |

Consecuencia esperada (pendiente de validar en AWS, R-PR7A-06): si PostgreSQL deja de responder durante más tiempo que el necesario para que el ALB marque los targets como no sanos (del orden de 3 comprobaciones de 15 s; **orientativo**, depende de los timeouts, del momento de cada comprobación y del ciclo del planificador), ECS podría reemplazar las tareas de forma repetida hasta que la base de datos vuelva, y el ALB pasaría a _fail-open_ si no queda ningún target sano. Las tareas nuevas tampoco superarían `/health/ready` mientras dure la caída.

La prueba local **solo** demuestra que, sin base de datos, los procesos siguen vivos, que `/health/ready` responde 503 y `/health` 200, que el healthcheck de contenedor (Docker, con los mismos parámetros) sigue sano, y que todo se recupera al restaurar PostgreSQL. No emula el ALB ni el planificador de ECS. Si este comportamiento es aceptable para el laboratorio (consecuencia de D-AWS-04-04) es una decisión pendiente para PR-7B.

## Resultado (2026-11-22, local)

Ejecución definitiva `spectra-pr7a-run5` (2026-11-22, 23:49–23:51 UTC) con las 9 imágenes `linux/amd64` del artefacto de la CI `ecr-release-72b715c` (run 44982468914; la aplicación no cambia entre `72b715c` y `a4a95b8`): **72/72 pruebas en verde, solo en local**. La validación real en ECS Fargate sigue pendiente (P1, C7–C9, P7 y R-PR7A-06). Evidencia: `EV-AWS-PR7A-ECS-PARITY-LOCAL-20261122` (bóveda académica), que conserva las ejecuciones anteriores (run1–run4) y un anexo con la corrección de la interpretación de la recuperación.

| Grupo                | Resultado                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuración        | 122/122 comprobaciones de la configuración renderizada frente a las task definitions; el verificador detecta 12/12 mutaciones y tiene 27 pruebas unitarias (`scripts/tests/test_parity_checks.py`)                                                                                       |
| Positivas            | 6 tareas de operación con `exitCode=0`; 4 servicios `healthy` en 24 s; `/health` y `/health/ready` 200; smoke E2E 11/11 (con ADMIN, KMS emulado y cookies `Secure`); DT-09 492/492; 4 roles `*_app` conectados con TLSv1.3; 0 errores de permisos                                        |
| Negativas            | Por servicio: 14 de 16 rutas sin escritura (raíz `ro`), uid 1000, 5 conjuntos de capacidades a 0, 0 binarios setuid/setgid, 5 intentos de escalada rechazados, PID 1 = `docker-init`; `sslmode=disable` y CA ajena rechazados                                                            |
| Recuperación (local) | Sin PostgreSQL, `/health/ready` 503 y `/health` 200; 65 s sin reinicios de contenedores y healthcheck de contenedor sano; al restaurarlo, `/health/ready` 200 y smoke 11/11; mismo `StartedAt`. **No demuestra** el comportamiento del ALB ni del reemplazo de tareas de ECS (R-PR7A-06) |

No hizo falta ningún volumen escribible: los servicios no escriben en disco.

## Riesgos residuales

| ID        | Riesgo                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-PR7A-01 | La prueba es local: Fargate (kernel, seccomp, `/dev/shm`, red awsvpc, IAM y endpoints de VPC) solo se valida con P1, C7–C9 y P7 en AWS                                                                                                                                                                                                                            |
| R-PR7A-02 | `/dev/shm` y `/dev/mqueue` son escribibles (montajes de Docker fuera de la raíz); no se ha comprobado su equivalente en Fargate                                                                                                                                                                                                                                   |
| R-PR7A-03 | `NoNewPrivs = 0`: Fargate no permite fijarlo; lo compensan las capacidades a 0 (también el conjunto límite) y la ausencia de binarios setuid/setgid                                                                                                                                                                                                               |
| R-PR7A-04 | Con raíz de solo lectura, la emulación amd64 de Docker Desktop (Rosetta) aborta procesos auxiliares como `pidof` (código 133). Es un artefacto local: no afecta a los servicios (0 abortos en sus logs) ni existe en Fargate x86 nativo                                                                                                                           |
| R-PR7A-05 | La librería `pg` del verificador DT-09 trata `sslmode=require` como `verify-full`: en AWS (P7, decisión 6.8) la imagen de verificación necesitará el bundle de CA de RDS                                                                                                                                                                                          |
| R-PR7A-06 | **Abierto, pendiente de validación en AWS.** Con PostgreSQL caído el tiempo suficiente para que el ALB marque los targets como no sanos (`/health/ready`), ECS puede reemplazar las tareas repetidamente hasta que vuelva la base de datos y el ALB puede pasar a _fail-open_. La prueba local no lo emula. Decisión de diseño pendiente para PR-7B (D-AWS-04-04) |
