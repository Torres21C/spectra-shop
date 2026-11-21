# Infraestructura como código — SPECTRA Shop (PR-5)

Terraform del **laboratorio académico** en AWS: red privada, RDS PostgreSQL, ECS Fargate, ECR, ALB interno, CloudFront con VPC origin y WAF, Secrets Manager, KMS, CloudWatch y Budgets.

> [!IMPORTANT]
> Este código **no se ha aplicado**: PR-5 prepara la infraestructura pero no la despliega. Arquitectura y decisiones: [ADR-AWS-05](../../docs/adr/ADR-AWS-05-arquitectura-laboratorio-terraform.md). Uso: [environments/lab/README.md](environments/lab/README.md).

## Estructura

```text
infra/terraform/
  .tflint.hcl  .trivyignore.yaml        configuración de la validación estática
  scripts/static-checks.sh              validación completa sin credenciales AWS (local y CI)
  scripts/ci/                           envoltorio de Terraform (bloquea apply/destroy) y Checkov fijado
  scripts/verify-routes.py              rutas de CloudFront/ALB frente a los controladores reales
  scripts/checkov-exceptions-doc.py     genera y comprueba docs/07 desde los comentarios checkov:skip
  bootstrap/                            bucket S3 + KMS del state (se aplica aparte, una vez)
  modules/
    network/          VPC, subredes privadas por AZ ID, IGW sin rutas, gateway S3, Flow Logs
    security_groups/  SG por servicio y por puerto; ALB solo desde CloudFront
    endpoints/        interface endpoints ecr.api, ecr.dkr, logs, secretsmanager, kms
    kms/              CMK de datos y clave ECC_NIST_P256 de firma de JWT (+ clave pública)
    database/         RDS PostgreSQL 16 privado, parameter group DT-09, logs exportados
    secrets/          secretos DT-09 y tokens (ephemeral + write-only, fuera del state)
    registry/         5 repositorios ECR inmutables con escaneo y ciclo de vida
    github_oidc_publisher/  rol OIDC publicador de ECR para GitHub Actions (PR-6; desactivado)
    alb/              ALB interno, target groups (/health/ready) y reglas por ruta
    edge/             S3 + OAC + CMK, VPC origin, CloudFront, cabeceras, WAF y sus logs
    observability/    log groups, filtros de métricas, alarmas, SNS y Budgets
    ecs/              clúster, Cloud Map, task definitions, roles IAM por carga y servicios
  environments/lab/   composición del laboratorio, variables validadas, salidas y pruebas
  docs/               matrices, costos, riesgos, validación y prerrequisitos
```

Se partió de la estructura propuesta para PR-5 con dos ajustes:

- No hay un módulo `identity/` de IAM. Los roles de ECS se generan **en el módulo `ecs`**, a partir de la misma definición que las task definitions, para que el permiso de lectura de secretos de cada rol coincida exactamente con lo que inyecta su tarea. Los otros roles (Flow Logs) viven con su recurso.
- `registry`/`compute`/`edge` se dividieron en `registry`, `alb`, `ecs` y `edge` para que el grafo sea lineal: ALB → CloudFront → ECS. `CORS_ORIGINS` necesita el dominio de CloudFront.

## Documentación

| Documento                                                                | Contenido                                   |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| [docs/01-arquitectura-y-recursos.md](docs/01-arquitectura-y-recursos.md) | Diagrama Mermaid y matriz de recursos AWS   |
| [docs/02-matriz-iam-y-red.md](docs/02-matriz-iam-y-red.md)               | Matriz IAM y de accesos de red              |
| [docs/03-costos.md](docs/03-costos.md)                                   | Estimación desglosada (no verificada)       |
| [docs/04-riesgos-y-decisiones.md](docs/04-riesgos-y-decisiones.md)       | Registro de riesgos y decisiones            |
| [docs/05-validacion-estatica.md](docs/05-validacion-estatica.md)         | Evidencias de la validación estática        |
| [docs/06-prerrequisitos-pr6-pr7.md](docs/06-prerrequisitos-pr6-pr7.md)   | Prerrequisitos de PR-6 y PR-7               |
| [docs/07-excepciones-checkov.md](docs/07-excepciones-checkov.md)         | Las 57 excepciones de Checkov, clasificadas |

## Publicación de imágenes (PR-6)

El workflow manual [`ecr-publish`](../../.github/workflows/ecr-publish.yml) construye, analiza y publica las 9 imágenes de un commit de `main` en los repositorios del módulo `registry`, con el rol del módulo `github_oidc_publisher` (desactivado hasta que el propietario lo autorice). Decisiones: [ADR-AWS-06](../../docs/adr/ADR-AWS-06-publicacion-ecr-oidc.md). Operación: [docs/operacion-y-aws/05-publicacion-ecr.md](../../docs/operacion-y-aws/05-publicacion-ecr.md).

## Validación en la CI

El workflow [`iac`](../../.github/workflows/iac.yml) ejecuta `scripts/static-checks.sh` en cada PR y push a `main`, con herramientas fijadas y sin credenciales AWS ni OIDC. Detalle: [docs/05-validacion-estatica.md §8](docs/05-validacion-estatica.md#8-validación-de-iac-en-la-ci-job-iac).
