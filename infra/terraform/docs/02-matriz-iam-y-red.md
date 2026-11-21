# Matriz de IAM y de accesos de red (PR-5)

## 1. IAM

Ninguna identidad usa credenciales estáticas. Las confianzas de `ecs-tasks.amazonaws.com` exigen `aws:SourceAccount` = la cuenta y `aws:SourceArn` = `arn:aws:ecs:us-east-1:<cuenta>:*` (mitigación de _confused deputy_).

### 1.1 Roles de ejecución (uno por carga de trabajo)

Todos tienen `ecr:GetAuthorizationToken` (no admite permisos por recurso), `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` y `ecr:BatchCheckLayerAvailability` **solo sobre su repositorio**, `logs:CreateLogStream` y `logs:PutLogEvents` **solo sobre su log group**, y `kms:Decrypt` sobre la CMK de datos **solo vía Secrets Manager** (`kms:ViaService`). El permiso `secretsmanager:GetSecretValue` se limita a:

| Rol (`spectra-lab-exec-…`) | Repositorio      | Secretos legibles                                            |
| -------------------------- | ---------------- | ------------------------------------------------------------ |
| `identity`                 | identity-service | `db/identity-app`, `internal-token`                          |
| `catalog`                  | catalog-service  | `db/catalog-app`, `internal-token`, `inventory-token`        |
| `commerce`                 | commerce-service | `db/commerce-app`, `internal-token`, `inventory-token`       |
| `audit`                    | audit-service    | `db/audit-app`, `internal-token`                             |
| `identity-migrate`         | identity-service | `db/identity-migrator` (+ `synthetic-admin` si existe)       |
| `catalog-migrate`          | catalog-service  | `db/catalog-migrator`                                        |
| `commerce-migrate`         | commerce-service | `db/commerce-migrator`                                       |
| `audit-migrate`            | audit-service    | `db/audit-migrator`                                          |
| `db-provision`             | db-ops           | maestro de RDS y los 8 `db/*` (solo usa la clave `password`) |
| `db-finalize`              | db-ops           | maestro de RDS                                               |

> `db-provision` necesita las 8 contraseñas porque `provision-service-roles.sql` fija todas en una transacción. Es la única carga con acceso amplio, se ejecuta a mano y nunca recibe tráfico.

### 1.2 Roles de tarea (credenciales dentro del contenedor)

| Rol                                            | Permisos                                                          | Condiciones                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `spectra-lab-task-identity`                    | `kms:Sign` sobre la clave de JWT                                  | `kms:SigningAlgorithm = ECDSA_SHA_256`, `kms:MessageType = RAW` |
|                                                | `kms:GetPublicKey` sobre la clave de JWT                          | —                                                               |
| catalog, commerce, audit y tareas de operación | **Sin rol de tarea**: el contenedor no recibe credenciales de AWS | —                                                               |

### 1.3 Otras identidades

| Identidad                                                                                               | Permisos                                                                                                                    | Estado                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `spectra-lab-vpc-flow-logs`                                                                             | `logs:CreateLogStream`, `logs:PutLogEvents` y `logs:DescribeLogStreams` sobre su log group                                  | PR-5                                                                                                                         |
| Principales de servicio en las políticas de clave                                                       | CloudWatch Logs (log groups de la cuenta), CloudWatch (SNS cifrado), CloudFront (solo la distribución, en la CMK de la SPA) | PR-5                                                                                                                         |
| Rol publicador OIDC `spectra-lab-ecr-publisher` (**PR-6**, desactivado: `enable_ecr_publisher = false`) | Solo publicar en los 5 repositorios ECR (§1.4)                                                                              | `aud` y `sub` exactos del Environment `ecr-publish-lab` ([ADR-AWS-06](../../../docs/adr/ADR-AWS-06-publicacion-ecr-oidc.md)) |
| Rol de despliegue OIDC (**PR-7, futuro**; distinto del publicador)                                      | actualización de ECS, `s3 sync` y CloudFront                                                                                | **No creado: PR-7** ([prerrequisitos](06-prerrequisitos-pr6-pr7.md))                                                         |
| Operadores humanos (Identity Center, `Lab-Admin`/`Lab-ReadOnly`)                                        | —                                                                                                                           | Fuera de Terraform (cuenta)                                                                                                  |

### 1.4 Rol publicador de ECR (PR-6)

Confianza: `sts:AssumeRoleWithWebIdentity` desde el proveedor `token.actions.githubusercontent.com`, con `StringEquals` sobre `aud = sts.amazonaws.com` y `sub = repo:Torres21C@84191196/spectra-shop@1457499804:environment:ecr-publish-lab`. Sesión de 1 hora como máximo. Lo usa solo el job `publish` del workflow `ecr-publish`.

| Acción                                                                      | Recurso        | Por qué                                                                               |
| --------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `ecr:GetAuthorizationToken`                                                 | `*`            | Inicio de sesión en el registro; la acción no admite restricción por recurso          |
| `ecr:BatchCheckLayerAvailability`                                           | 5 repositorios | Saber qué capas ya existen antes de subir                                             |
| `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` | 5 repositorios | Subir las capas                                                                       |
| `ecr:PutImage`                                                              | 5 repositorios | Registrar el manifiesto con su etiqueta (inmutable)                                   |
| `ecr:BatchGetImage`                                                         | 5 repositorios | Incluida en la política de publicación documentada por AWS (`image-push-iam`)         |
| `ecr:DescribeImages`                                                        | 5 repositorios | Comprobar si la etiqueta ya existe (sin sobrescribir) y verificar el digest publicado |

**No tiene:** KMS (ECR cifra con su propia concesión sobre la CMK; se confirma en P-PUB-1), `ecr:BatchDeleteImage`, `ecr:PutImageTagMutability`, `ecr:SetRepositoryPolicy`, `ecr:PutLifecyclePolicy`, ni permisos de ECS, IAM, Secrets Manager, S3, STS, CloudFormation o CloudWatch Logs. Lo comprueban las pruebas de `tests/modules_publisher.tftest.hcl`.

## 2. Accesos de red

Ninguna regla usa un CIDR: solo referencias entre security groups o prefix lists gestionados por AWS. Ninguna regla abre el puerto 22.

| Origen                                                                                   | Destino                                                   | Puerto                    | Motivo                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| CloudFront (prefix list `origin-facing` → después SG `CloudFront-VPCOrigins-Service-SG`) | `sg-alb`                                                  | 80                        | VPC origin (C5, desviación)                                                       |
| `sg-alb`                                                                                 | `sg-identity` / `sg-catalog` / `sg-commerce` / `sg-audit` | 3001 / 3002 / 3003 / 3004 | Tráfico y health checks                                                           |
| `sg-catalog`, `sg-commerce`, `sg-audit`                                                  | `sg-identity`                                             | 3101                      | `validate-touch`                                                                  |
| `sg-commerce`                                                                            | `sg-catalog`                                              | 3102                      | Snapshot del carrito y reservas de stock                                          |
| `sg-catalog`                                                                             | `sg-audit`                                                | 3104                      | Relay de la outbox                                                                |
| 4 servicios y `sg-ops`                                                                   | `sg-rds`                                                  | 5432                      | PostgreSQL (`sslmode=require`, C6)                                                |
| 4 servicios y `sg-ops`                                                                   | `sg-vpce`                                                 | 443                       | ECR, Logs, Secrets Manager y KMS                                                  |
| 4 servicios y `sg-ops`                                                                   | prefix list de S3                                         | 443                       | Capas de ECR (gateway; política solo para `prod-us-east-1-starport-layer-bucket`) |

**No permitido (comprobado):** el ALB no llega a 3101, 3102 ni 3104; Commerce no expone puerto interno; RDS y los endpoints no tienen reglas de salida; ninguna tarea ni subred tiene IP pública; ninguna tabla de rutas apunta al IGW ni a una NAT.

| Componente                        | Exposición pública                                                           |
| --------------------------------- | ---------------------------------------------------------------------------- |
| CloudFront                        | Sí (único punto de entrada; WAF)                                             |
| Bucket de la SPA                  | No (Block Public Access; solo OAC de esta distribución)                      |
| ALB                               | No (interno; solo VPC origin)                                                |
| Tareas ECS                        | No (subredes privadas, sin IP pública)                                       |
| RDS                               | No (subred de datos, `publicly_accessible = false`)                          |
| `/docs`, `/health`, `/internal/*` | No se enrutan en CloudFront ni en el ALB (devuelven 403 de S3 o 404 del ALB) |
