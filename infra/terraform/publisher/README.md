# Raíz `publisher` — repositorios ECR y rol publicador (PR-6.2)

> [!WARNING]
> **No se ha aplicado.** `init` con backend, `plan`, `apply` y `destroy` contra AWS requieren la **autorización expresa del propietario** en cada ocasión. Decisiones: [ADR-AWS-06](../../../docs/adr/ADR-AWS-06-publicacion-ecr-oidc.md), D-AWS-06-17 a D-AWS-06-20. Operación de la publicación: [guía 05](../../../docs/operacion-y-aws/05-publicacion-ecr.md).

## 1. Qué administra y qué no

Raíz independiente de `environments/lab`, con su propio state. Existe para que habilitar la publicación **no pueda** desplegar el laboratorio: en la raíz `lab`, `enable_ecr_publisher = true` habría creado 216 recursos.

| Crea (12 recursos, o 13 con el proveedor OIDC)                                                                                | Nunca crea                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 5 `aws_ecr_repository` (`spectra/identity-service`, `catalog-service`, `commerce-service`, `audit-service` y `db-ops`)        | VPC, subredes, endpoints, NAT ni rutas                                     |
| 5 `aws_ecr_lifecycle_policy` (sin etiqueta: 7 días; etiquetadas: las últimas `ecr_keep_images`)                               | ECS, RDS, ALB, CloudFront ni WAF                                           |
| Con `enable_ecr_publisher = true`: `aws_iam_role` `spectra-lab-ecr-publisher` y su `aws_iam_role_policy` `ecr-publish-only`   | Secrets Manager, CloudWatch, SNS ni claves KMS                             |
| Con `enable_ecr_publisher = true` y `create_github_oidc_provider = true`: `aws_iam_openid_connect_provider` de GitHub Actions | El bucket del state, su auditoría ni el presupuesto (los crea `bootstrap`) |

Lo garantiza `scripts/check_state_ownership.py` (lista permitida de tipos y propiedad exclusiva entre raíces), que se ejecuta en `static-checks.sh` y en la CI.

- **Repositorios:** etiquetas `IMMUTABLE`, `scan_on_push` y cifrado KMS con la **clave administrada por AWS `aws/ecr`** (D2). El cifrado no se puede cambiar después: pasar a una CMK propia exige recrear los repositorios.
- **Rol:** confianza exacta (`aud = sts.amazonaws.com`, `sub = repo:Torres21C@84191196/spectra-shop@1457499804:environment:ecr-publish-lab`, `StringEquals`) y permisos de publicación solo sobre los 5 ARN, más `ecr:GetAuthorizationToken` sobre `*`. Sin KMS, ECS, IAM, Secrets Manager, S3 ni borrado.
- **Proveedor OIDC (D3):** si la cuenta ya lo tiene, `create_github_oidc_provider = false`. Se lee por su URL con un data source y una postcondición exige la audiencia `sts.amazonaws.com`. **No se importa** ni se administra aquí. PR-7 lo leerá igual, nunca lo creará.

## 2. Orden y dependencias

```text
1. bootstrap   → bucket y CMK del state, auditoría CloudTrail, presupuesto de la cuenta (state local)
2. publisher   → esta raíz (state spectra-shop/publisher/terraform.tfstate)
3. lab         → laboratorio; LEE los repositorios con data "aws_ecr_repository" (no los crea)
```

Ninguna raíz lee el state de otra (`terraform_remote_state` está prohibido): `lab` encuentra los repositorios por su nombre a través de la API de AWS.

## 3. Procedimiento (cada paso con autorización)

1. Consultas de solo lectura: cuenta e identidad (`aws sts get-caller-identity`), proveedor OIDC existente (`aws iam list-open-id-connect-providers`), que no existan ya `spectra/*` en ECR ni el rol `spectra-lab-ecr-publisher`.
2. `cp backend.hcl.example backend.hcl` y `cp terraform.tfvars.example terraform.tfvars` (ambos ignorados por Git). Ajustar `create_github_oidc_provider` según el paso 1.
3. Comprobar el prefijo inmutable del `sub`: `gh api repos/Torres21C/spectra-shop/actions/oidc/customization/sub`.
4. Plan y revisión:

   ```sh
   cd infra/terraform/publisher
   terraform init -backend-config=backend.hcl
   terraform plan -out=tfplan                                   # fuera del repositorio o borrar después
   terraform show -json tfplan | jq -r '.resource_changes[] | [.change.actions[0], .type, .address] | @tsv'
   ```

   Aceptar solo si: todas las acciones son `create`; los tipos son exclusivamente `aws_ecr_repository` (5), `aws_ecr_lifecycle_policy` (5) y, con el publicador, `aws_iam_role`, `aws_iam_role_policy` y, si no existía, `aws_iam_openid_connect_provider`; 0 cambios y 0 destrucciones.

5. `terraform apply tfplan`. Salida `ecr_publisher_role_arn` → variable `AWS_ECR_PUBLISHER_ROLE_ARN` del Environment `ecr-publish-lab` (no es un secreto).

## 4. Contingencia: recursos ya creados desde `lab`

Si una consulta previa mostrara repositorios o el rol creados por un `apply` antiguo de `lab`:

- En `lab`, los bloques `removed { lifecycle { destroy = false } }` los sacan de su state **sin destruirlos**.
- En esta raíz se adoptan con bloques `import` temporales (rol, política inline, proveedor y repositorios por nombre), revisando que el plan no proponga reemplazos.
- **Repositorios cifrados con la CMK de datos de `lab`:** no se pueden adoptar con `aws/ecr` sin recrearlos (el cifrado es inmutable). Detenerse y decidir con el propietario.

## 5. Reversión

- **Contención inmediata, sin Terraform:** quitar la variable `AWS_ECR_PUBLISHER_ROLE_ARN` del Environment o el Environment entero: `publish` falla antes de pedir el token.
- **Solo el rol:** `enable_ecr_publisher = false` y `apply`. Se eliminan el rol, su política y, si lo creó esta raíz, el proveedor OIDC. Los repositorios y sus imágenes se conservan.
- **Todo:** vaciar los repositorios (un administrador, `aws ecr batch-delete-image`; el rol publicador no puede borrar) y `destroy`. `ecr_force_delete = false` impide destruir repositorios con imágenes. Antes, destruir o dejar de usar `lab`, que los lee.

## 6. Pruebas sin AWS

`terraform test` (proveedor simulado, solo `plan`): `tests/publisher_plan.tftest.hcl` (los 5 repositorios, el rol limitado a ellos, el proveedor existente) y `tests/modules_publisher.tftest.hcl` (confianza exacta, mínimo privilegio, proveedor existente validado por audiencia, rechazo de comodines y del formato antiguo del `sub`). Se ejecutan con `../scripts/static-checks.sh`.
