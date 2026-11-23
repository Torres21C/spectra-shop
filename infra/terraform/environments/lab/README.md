# Entorno `lab` — laboratorio académico SPECTRA Shop en AWS

> [!WARNING]
> **PR-5 prepara la infraestructura, no la despliega.** Ningún comando de este documento se ha ejecutado contra AWS. `apply`, `destroy` y `run-task` requieren la **autorización expresa del propietario** en cada ocasión, credenciales temporales (IAM Identity Center o el rol OIDC de PR-6) y presupuesto activo. Decisiones de arquitectura: [ADR-AWS-05](../../../../docs/adr/ADR-AWS-05-arquitectura-laboratorio-terraform.md).

## 1. Requisitos

| Herramienta                                | Versión verificada                                             | Uso                                                        |
| ------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Terraform                                  | 1.17.2 (mínimo 1.11: recursos efímeros y atributos write-only) | IaC                                                        |
| `hashicorp/aws`                            | 6.70.0 (`~> 6.70.0`, fijado en `.terraform.lock.hcl`)          | Proveedor                                                  |
| `hashicorp/random`                         | 3.9.1 (`~> 3.9.0`)                                             | `ephemeral "random_password"`                              |
| AWS CLI v2, `jq`                           | —                                                              | Solo para `run-task` y comprobaciones (no se usan en PR-5) |
| TFLint 0.66.0, Checkov 3.4.6, Trivy 0.76.2 | —                                                              | Validación estática (`../../scripts/static-checks.sh`)     |

Región fija: `us-east-1` (AD-01; validada en `variables.tf`).

## 2. Estado remoto (una sola vez, con autorización)

1. Aplicar `infra/terraform/bootstrap` (bucket S3 versionado y cifrado con KMS, solo TLS y `prevent_destroy`; desde PR-6.2, también la auditoría de los accesos al state con CloudTrail y el presupuesto de la cuenta, que exige `budget_emails` en su `terraform.tfvars`):

   ```sh
   cd infra/terraform/bootstrap
   terraform init && terraform plan && terraform apply   # AUTORIZACIÓN PREVIA
   ```

   Su state es local y no contiene secretos. Guárdelo fuera del repositorio (p. ej. `~/.config/spectra-shop/tfstate-bootstrap/`, con modo 600) o mígrelo al propio bucket después.

2. **Aplicar `infra/terraform/publisher`** (PR-6.2): crea los 5 repositorios ECR que lee este entorno ([publisher/README.md](../../publisher/README.md)). Sin ellos, `plan` falla en `data "aws_ecr_repository"`.
3. Copiar `backend.hcl.example` a `backend.hcl` (ignorado por Git) y completar `bucket` y `kms_key_id` con las salidas del bootstrap. El bloqueo usa `use_lockfile = true` (bloqueo nativo de S3, sin DynamoDB).

## 3. Ciclo de vida

### 3.1 Inicializar y planificar

```sh
cd infra/terraform/environments/lab
cp terraform.tfvars.example terraform.tfvars        # ignorado por Git; sin secretos
terraform init -backend-config=backend.hcl
terraform plan                                     # no guarde planes dentro del repositorio
```

`image_tag` es el SHA completo del commit cuyas imágenes publicó PR-6 en ECR (servicios `:<sha>`, migraciones `:<sha>-migrate`, `db-ops:<sha>`). `lab_cycle_id` es obligatorio, identifica una sola creación y no puede cambiar hasta haber destruido y verificado el ciclo. Se registra en etiquetas y en los nombres `spectra/lab/<ciclo>/...`, pero no cambia el backend ni ECR. Véase el [runbook efímero](../../../../docs/operacion-y-aws/07-ciclo-laboratorio-efimero.md).

### 3.2 Primer `apply` (sin tareas)

Con `service_desired_count = 0` y `alb_ingress_source = "prefix_list"`. Crea la red, los endpoints, KMS, RDS, secretos con valores generados, ALB, CloudFront con WAF, task definitions y servicios ECS **sin tareas**. ECR pertenece a `publisher` y aquí solo se lee. La política fija `synthetic-discard`: datos ficticios regenerables y ningún snapshot final cifrado por la CMK efímera. Antes debe existir el presupuesto (variable `budget_emails`). Este y todo `apply` posterior se hacen sobre un plan guardado validado con `lab_teardown_guard.py --mode deploy` ([runbook §3.0](../../../../docs/operacion-y-aws/07-ciclo-laboratorio-efimero.md)); el guard rechaza cambiar `lab_cycle_id` sobre un state activo.

### 3.3 Aprovisionamiento y migraciones (manual, en serie)

Terraform **solo define** las tareas; nunca las ejecuta (DT-09). El runbook definitivo es parte de PR-7; orden y comandos de referencia:

```sh
# synthetic-discard: no crear snapshots manuales; los datos se reconstruyen con migraciones y seeds.
CLUSTER=$(terraform output -raw ecs_cluster_name)
NET=$(terraform output -json run_task_network_configuration)
for t in db-provision identity-migrate catalog-migrate commerce-migrate audit-migrate db-finalize; do
  FAMILY=$(terraform output -json ops_task_definition_families | jq -r --arg t "$t" '.[$t]')
  TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE \
    --network-configuration "{\"awsvpcConfiguration\": $NET}" --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
  CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
  [ "$CODE" = "0" ] || { echo "Falló $t (exitCode=$CODE): revisar /spectra/lab/$t"; break; }
done
```

Se detiene ante el primer fallo. `db-provision` aborta si el servidor registra sentencias o si el maestro no tiene `CREATEROLE`/`CREATEDB` (ADR-AWS-01). La verificación DT-09 (`verify-db-isolation.mjs`) necesita una imagen con el script: queda pendiente para PR-6/PR-7.

### 3.4 Segundo `apply` (servicios)

`service_desired_count = 1`. Comprobar los targets `healthy` (`/health/ready`). Después, opcionalmente, `alb_ingress_source = "vpc_origin_sg"` y otro `apply`: el ALB solo admitirá el SG gestionado `CloudFront-VPCOrigins-Service-SG` (más restrictivo que el prefix list).

### 3.5 Web

PR-6 compila la SPA con `VITE_*_API_URL = $(terraform output -raw public_origin)`, la sube con `s3 sync` al bucket `spa_bucket_name` (SSE-KMS con `spa_kms_key_arn`) e invalida `/index.html` y `/`.

### 3.6 Pausa

`service_desired_count = 0` + `apply` detiene Fargate. **El resto sigue cobrando** (endpoints, ALB, WAF, RDS, secretos y KMS; ver `../../docs/03-costos.md`). `aws rds stop-db-instance` detiene la instancia como máximo 7 días; después se reinicia sola.

### 3.7 Destrucción controlada (con autorización)

1. Preservar las evidencias fuera de recursos cifrados por las CMK efímeras. No puede haber datos reales: `synthetic-discard` omite incondicionalmente el snapshot final, porque conservarlo mientras se elimina su CMK produciría una copia irrecuperable.
2. Copiar `teardown.tfvars.example` a `teardown.tfvars`. El overlay no contiene `lab_cycle_id`: debe cargarse
   junto al `terraform.tfvars` del ciclo con ambos `-var-file` explícitos.
3. Generar plan guardado, JSON y `terraform state pull`; validar backend, workspace, lineage, ciclo y allowlist
   con `lab_teardown_guard.py --mode prepare` antes de aplicar el plan autorizado.
4. Confirmar cero tareas. Generar un plan guardado con `-destroy` y los mismos dos `-var-file`; validarlo con
   `lab_teardown_guard.py --mode destroy` y aplicar **ese plan**, nunca un destroy directo. No usar
   `-auto-approve`. Los comandos exactos están en el [runbook](../../../../docs/operacion-y-aws/07-ciclo-laboratorio-efimero.md).
5. Los secretos mantienen 7 días de recuperación; las claves usan 14 días por defecto y como mínimo un día
   adicional. Recuperar exige cancelar el borrado de la CMK antes de que venza y restaurar ambos recursos; no
   constituye un backup.
6. Con autorización de lectura posterior, comprobar residuos por `Project`, `Environment` y `LabCycle`, y revisar costos 24–48 h después.

## 4. Secretos: inicialización y rotación

**Principio:** ninguna contraseña, token ni clave privada pasa por el state, el plan, los tfvars ni los logs de Terraform.

| Secreto                                          | Contenido                             | Generación                                                              | Lo consume                                                         |
| ------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `spectra/lab/<ciclo>/db/<svc>-migrator` (×4)     | `{username, password, url}`           | `ephemeral random_password` (64 hex) → `secret_string_wo`               | `db-provision` (`password`), `<svc>-migrate` (`url`)               |
| `spectra/lab/<ciclo>/db/<svc>-app` (×4)          | ídem                                  | ídem                                                                    | `db-provision` (`password`), servicio `<svc>` (`url`)              |
| `spectra/lab/<ciclo>/internal-token`             | 64 hex                                | ídem                                                                    | `SPECTRA_INTERNAL_TOKEN(S)` en identity, catalog, commerce y audit |
| `spectra/lab/<ciclo>/inventory-token`            | 64 hex, distinto                      | ídem                                                                    | `CATALOG_INVENTORY_TOKEN(S)` (commerce → catalog)                  |
| `spectra/lab/<ciclo>/synthetic-admin` (opcional) | `{email, password}`                   | correo de la variable; contraseña efímera de 32 caracteres              | `identity-migrate` (seed, solo inserta)                            |
| `rds!db-…`                                       | `{username, password}` del maestro    | **RDS** (`manage_master_user_password`), con rotación automática de RDS | `db-provision`, `db-finalize`                                      |
| Clave de firma JWT                               | Clave privada P-256 **dentro de KMS** | `aws_kms_key` `ECC_NIST_P256`                                           | identity (`kms:Sign`); la pública va en `IDENTITY_PUBLIC_KEY_PEM`  |

**Cómo funciona.** El valor efímero se genera en memoria en cada ejecución. `secret_string_wo` solo se envía al **crear** el secreto o cuando aumenta `secret_string_wo_version` (variable `secret_versions`). En las demás ejecuciones el valor generado se descarta.

**Rotación:**

- **Contraseña de un rol** (p. ej. `catalog-app`):
  1. `secret_versions = { "db/catalog-app" = 2 }` y `apply`. Se escribe la nueva contraseña con su URL.
  2. `run-task db-provision`, que ejecuta `ALTER ROLE` con las 8 contraseñas actuales.
  3. `aws ecs update-service --force-new-deployment` del servicio afectado.

  Entre los pasos 2 y 3 las conexiones nuevas del servicio fallan: breve indisponibilidad aceptada en el laboratorio.

- **Si RDS se reemplaza** (cambia el endpoint), suba la versión de los 8 secretos de rol: sus URL contienen el endpoint y no se reescriben solas.
- **Tokens internos:** suba la versión y redespliegue juntos todos los servicios que los usan. `SPECTRA_INTERNAL_TOKENS` admite dos valores para una rotación sin cortes, pero el laboratorio usa uno solo: puede haber 401 entre servicios durante el despliegue.
- **Clave de JWT** (ADR-AWS-02): `terraform apply -replace=module.kms.aws_kms_key.jwt` y redesplegar los 4 servicios. Los JWT emitidos con la clave anterior caducan en 15 minutos; puede haber 401 que obliguen a refrescar la sesión.

## 5. `TRUST_PROXY` (pendiente de la prueba P10)

| Valor                       | Cuándo es correcto                                                                             | Riesgo                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"false"` (**por defecto**) | Siempre seguro: no confía en `X-Forwarded-For`                                                 | Los límites por IP de la aplicación (registro 10/min, login 20/min, 120/min) ven la IP del ALB y se vuelven **globales**; WAF sigue limitando por IP real |
| `"2"`                       | Si P10 confirma exactamente dos proxies (CloudFront y ALB) delante de la tarea                 | Si cambia la cadena (p. ej. otro proxy), la IP resultante sería incorrecta                                                                                |
| `"10.20.0.0/16"`            | Solo si P10 muestra que el ALB recibe el tráfico de CloudFront desde IP **privadas** de la VPC | Si el ALB ve IP públicas de CloudFront (lo que sugiere la documentación), `req.ip` sería la IP de CloudFront                                              |

P10: con `TRUST_PROXY="false"`, registrar `X-Forwarded-For` y la IP del socket en una tarea de prueba (sin datos personales), enviar una cabecera `X-Forwarded-For` falsa desde el cliente y comprobar qué entrada corresponde al visitante. `"true"` está prohibido (lo rechazan la validación de Terraform y la aplicación).

## 6. Validación estática

```sh
infra/terraform/scripts/static-checks.sh
```

No usa credenciales: `fmt`, `init -backend=false`, `validate`, `terraform test` con proveedores simulados (solo `plan`), TFLint, Checkov, Trivy (misconfiguración y secretos), la verificación de rutas frente a los controladores (`verify-routes.py`) y búsquedas de patrones prohibidos. Resultados: `../../docs/05-validacion-estatica.md`.

- La CI ejecuta el mismo script en el workflow `iac` (`.github/workflows/iac.yml`), con las mismas versiones fijadas.
- Checkov debe estar **completo**. La fórmula de Homebrew 3.4.6 no trae las comprobaciones de grafo; si el script lo detecta, usa la imagen oficial fijada (`scripts/ci/checkov-docker.sh`, requiere Docker) o falla.
- Trivy usa las reglas incluidas en su binario (caché vacía), igual que en la CI.

## 7. Repositorios ECR y rol publicador (PR-6.2: fuera de este entorno)

Este entorno **no** crea repositorios ECR ni el rol publicador, y no tiene `enable_ecr_publisher`: un `apply` aquí crea el laboratorio completo (216 recursos), así que la publicación se habilita en su propia raíz, [`infra/terraform/publisher`](../../publisher/README.md), con su propio state (ADR-AWS-06, D-AWS-06-17). `lab` lee los 5 repositorios con `data "aws_ecr_repository"` por nombre (`spectra/<repositorio>`) y los bloques `removed` sacan `module.registry` y `module.ecr_publisher` de un state antiguo sin destruirlos. Después de publicar, `image_tag` = SHA del commit publicado.
