# Ciclo operativo del laboratorio AWS efímero

Este runbook prepara el procedimiento; no autoriza llamadas AWS ni operaciones Terraform. Cada `plan`,
`apply`, ejecución de tareas y `destroy` requiere autorización expresa. Nunca se usa `-auto-approve`.

## 1. Invariantes

- Raíces y states separados: `bootstrap` → `publisher` → `environments/lab`.
- `lab_cycle_id` identifica una sola creación y no cambia mientras exista infraestructura.
- `lab_data_policy = "synthetic-discard"`: no entran datos reales o irreemplazables.
- `lab` no administra ECR, OIDC, backend, auditoría ni la CMK del state.
- El state remoto de `lab` se conserva después del destroy, aunque ya no contenga recursos.
- Los secretos no aparecen en plan, state, tfvars, comandos ni evidencias.
- La ventana de borrado KMS es al menos un día mayor que la recuperación de los secretos cifrados (14 frente
  a 7 días por defecto). Es un margen operativo, no una garantía de recuperación automática.
- Ningún `apply` se ejecuta sin un plan guardado validado por `lab_teardown_guard.py` (§3.0); el guard rechaza
  cambiar `lab_cycle_id` sobre un state activo también en despliegues y actualizaciones normales.

### 1.1 Aclaración normativa: snapshots bajo `synthetic-discard`

Esta aclaración rige la operación vigente del laboratorio efímero y prevalece, solo para `environments/lab`
con `lab_data_policy = "synthetic-discard"`, sobre las menciones a snapshots manuales, snapshot previo a
migraciones o restauración desde snapshot que conservan los documentos históricos aprobados
(`infra/terraform/docs/06-prerrequisitos-pr6-pr7.md` filas 7.2, 7.4 y 7.6; R-PR5-15 en
`infra/terraform/docs/04-riesgos-y-decisiones.md`; AWS-26 en `03-diagnostico-aws.md`). Esos documentos no se
modifican: registran lo aprobado en su momento. Decisión del propietario del 2026-11-22 (remediación F-05).

- **No se crean snapshots manuales ni finales de RDS** como mecanismo de respaldo, rollback o evidencia.
- Un snapshot cifrado con la CMK efímera del ciclo deja de ser restaurable cuando esa CMK se elimina; además
  sigue facturando y bloquea el cierre del ciclo (§9).
- La recuperación ante un fallo de migración es destruir y reconstruir el ciclo desde migraciones y seeds, o
  una corrección hacia delante. No existe rollback de datos en `lab`.
- Cualquier retención de datos exige otra política, una CMK persistente fuera del state efímero y un ADR
  aprobado; no basta con cambiar `skip_final_snapshot`.

## 2. PREPARAR

1. Registrar autorización, responsable de encendido, responsable de apagado y hora límite.
2. Confirmar inventario residual vacío y que no existe otro ciclo activo.
3. Elegir un identificador nuevo, por ejemplo `20261122-a`, y registrarlo en el acta de sesión.
4. Confirmar SHA, arquitectura y los nueve tags/digests OCI publicados por `publisher`.
5. Copiar `terraform.tfvars.example` fuera de Git y completar correos, SHA y `lab_cycle_id`.
6. Crear `lab-state-identity.json` del ciclo a partir del ejemplo, fuera del repositorio: backend real aprobado,
   workspace `default`, el `lab_cycle_id` nuevo y, si el backend ya tiene state (ciclos posteriores, state
   conservado vacío), su `lineage` y `serial` actuales como `minimum_serial`. Solo si el backend nunca tuvo
   state se registra `"lineage": null` y `"minimum_serial": 0`. Conservar su hash en el acta.
7. Validar localmente `fmt`, `validate`, pruebas simuladas, TFLint, Checkov, Trivy y propiedad de states.
8. Inicializar únicamente el backend de `lab` y comprobar la clave estable
   `spectra-shop/lab/terraform.tfstate`.
9. Revisar el plan: solo recursos de `lab`, servicios ECS a cero, RDS protegido, sin snapshot final y secretos
   bajo `spectra/lab/<lab_cycle_id>/`.
10. Establecer un costo máximo de sesión y una hora de aborto. AWS Budgets avisa con retraso y no detiene nada.

## 3. DESPLEGAR

### 3.0 Guard obligatorio antes de cada `apply` del ciclo

Todo `apply` del laboratorio (primer despliegue, escalado a una tarea, restricción del ALB y cualquier
actualización posterior) usa un plan guardado y validado. Desde `infra/terraform/environments/lab`, en un
directorio de evidencia fuera del repositorio:

```sh
terraform plan -var-file=terraform.tfvars -out="$EVIDENCE_DIR/deploy.tfplan"
terraform show -json "$EVIDENCE_DIR/deploy.tfplan" > "$EVIDENCE_DIR/deploy-plan.json"
terraform state pull > "$EVIDENCE_DIR/lab-state-before-deploy.json"   # vacío si el backend no tiene state
PLAN_SHA256=$(shasum -a 256 "$EVIDENCE_DIR/deploy.tfplan" | cut -d' ' -f1)
python3 ../../scripts/lab_teardown_guard.py --mode deploy \
  --identity "$EVIDENCE_DIR/lab-state-identity.json" \
  --backend-metadata .terraform/terraform.tfstate \
  --workspace-file .terraform/environment \
  --state "$EVIDENCE_DIR/lab-state-before-deploy.json" \
  --plan "$EVIDENCE_DIR/deploy-plan.json" \
  --plan-file "$EVIDENCE_DIR/deploy.tfplan" \
  --plan-sha256 "$PLAN_SHA256"
```

El guard es local y de solo lectura: no ejecuta Terraform ni AWS. Verifica el backend inicializado (bucket,
clave `spectra-shop/lab/terraform.tfstate`, región, KMS), el workspace `default` y que el plan binario:

- tiene el SHA-256 aprobado y fue generado con Terraform 1.17.2 (formato verificado), sin `-target`,
  completo, sin errores y en modo normal;
- declara el mismo backend y workspace que la identidad aprobada;
- contiene las mismas variables, cambios de recursos y outputs que el JSON revisado;
- fue generado contra el state obtenido: mismo lineage, mismo serial y mismas instancias.

Con state vacío solo admite el primer despliegue del ciclo de la identidad (únicamente creaciones). Con state
activo exige lineage, serial y ciclo aprobados; rechaza cambiar `lab_cycle_id` (en el JSON o en el binario),
planes parciales, `teardown_mode=true`, recursos de `bootstrap`/`publisher` y eliminar o reemplazar RDS,
secretos o claves KMS. Una segunda persona revisa el JSON y el resultado; con autorización se aplica
exclusivamente ese archivo tras comprobar de nuevo su hash: `terraform apply "$EVIDENCE_DIR/deploy.tfplan"`.
Tras el primer `apply`, si la identidad tenía `"lineage": null`, se registra el lineage y el serial del state
creado en una versión nueva de la identidad (nuevo hash en el acta) antes de cualquier otro plan.

**Riesgo residual del guard.** Es un control operativo: protege solo si se invoca antes de cada `apply` y
si se aplica exclusivamente el plan con el SHA-256 validado. Terraform no impide por sí mismo un `apply`
directo en la estación del operador (la CI sí lo bloquea). Su lector del plan binario está ligado al formato
de Terraform 1.17.2, la versión fijada en la CI: con otra versión falla cerrado y requiere verificar el formato
y actualizar el guard y sus pruebas antes de operar.

### 3.1 Secuencia

1. Confirmar que `bootstrap` y `publisher` existen y que ECR contiene los digests aprobados.
2. Aplicar, con el procedimiento de §3.0, el plan revisado con `service_desired_count=0`.
3. Esperar RDS, endpoints y task definitions; no iniciar servicios todavía.
4. Ejecutar una sola vez y en serie: `db-provision`, `identity-migrate`, `catalog-migrate`,
   `commerce-migrate`, `audit-migrate`, `db-finalize`. Detenerse ante el primer exit code distinto de cero.
5. Ejecutar DT-09 y conservar resultados sanitizados.
6. Aplicar `service_desired_count=1` (§3.0) y comprobar `/health/ready` en los cuatro target groups.
7. Tras validar el VPC origin, restringir el ALB al SG administrado de CloudFront si P10 lo permite (§3.0).
8. Publicar la SPA desde el artefacto del mismo SHA; no reconstruir desde una rama diferente.

## 4. VALIDAR Y DEMOSTRAR

- `/health` en contenedores y `/health/ready` en ALB.
- TLS RDS y parámetros de registro; aislamiento DT-09.
- Usuario no privilegiado, raíz de solo lectura, `cap_drop ALL` e `init`.
- CloudFront, WAF, cabeceras y rutas `/docs`, `/health` e `/internal` no expuestas.
- Smoke tests y flujo funcional exclusivamente con cuentas y datos sintéticos.
- SHA, digests, `lab_cycle_id`, región, arquitectura y tiempos de sesión.
- No aumentar tareas, AZ de endpoints, almacenamiento ni observabilidad durante la demostración.

## 5. PRESERVAR EVIDENCIAS

Antes de programar el borrado de las CMK efímeras, exportar fuera del laboratorio:

- manifiesto SHA256, SHA Git, tags/digests y `lab_cycle_id`;
- planes y resúmenes de operaciones aprobadas, sin valores secretos;
- resultados DT-09, smoke y seguridad de contenedores;
- estado de servicios, target groups y configuración efectiva sanitizada;
- logs estrictamente necesarios, sin tokens, cookies, URL con contraseñas ni datos personales;
- inventario previo al apagado y lista de excepciones.

Un log, secreto o snapshot cifrado solo con una CMK que será eliminada no cuenta como evidencia preservada.

## 6. PREPARAR EL APAGADO

1. Bloquear nuevas pruebas y comprobar que no hay `run-task` de migración en ejecución.
2. Conservar fuera del repositorio y con acceso restringido el `terraform.tfvars` original. Copiar
   `teardown.tfvars.example` a `teardown.tfvars`; el overlay no contiene ni puede sustituir `lab_cycle_id`.
3. Usar la `lab-state-identity.json` vigente del ciclo (§2 y §3.0), con lineage registrado y el
   `lab_cycle_id` original. Cambiar este archivo durante un ciclo invalida la revisión y exige una nueva
   aprobación.
4. En un directorio de evidencia fuera del repositorio, generar los artefactos de preparación cargando ambos
   archivos de variables de forma explícita:

   ```sh
   terraform plan -var-file=terraform.tfvars -var-file=teardown.tfvars -out="$EVIDENCE_DIR/prepare.tfplan"
   terraform show -json "$EVIDENCE_DIR/prepare.tfplan" > "$EVIDENCE_DIR/prepare-plan.json"
   terraform state pull > "$EVIDENCE_DIR/lab-state-before-prepare.json"
   PLAN_SHA256=$(shasum -a 256 "$EVIDENCE_DIR/prepare.tfplan" | cut -d' ' -f1)
   python3 ../../scripts/lab_teardown_guard.py --mode prepare \
     --identity "$EVIDENCE_DIR/lab-state-identity.json" \
     --backend-metadata .terraform/terraform.tfstate \
     --workspace-file .terraform/environment \
     --state "$EVIDENCE_DIR/lab-state-before-prepare.json" \
     --plan "$EVIDENCE_DIR/prepare-plan.json" \
     --plan-file "$EVIDENCE_DIR/prepare.tfplan" \
     --plan-sha256 "$PLAN_SHA256"
   ```

   Estos comandos requieren autorización cuando acceden al backend; el guard es local y de solo lectura.
   El guard exige la clave `spectra-shop/lab/terraform.tfstate`, región `us-east-1`, workspace `default`,
   lineage, serial y ciclo aprobados, también en el `prior_state` del plan. Solo permite ECS
   `desired_count=0`, RDS `deletion_protection=false`, bucket SPA `force_destroy=true`, ALB
   `enable_deletion_protection=false` (si el ciclo la había activado) y el output `teardown_mode=true`;
   rechaza creación, reemplazo, borrado o cualquier otro atributo. Además exige que el plan cubra exactamente
   las instancias administradas del state obtenido y aplica las mismas comprobaciones del plan binario que
   §3.0, de modo que un plan generado contra otro state, parcial o distinto del JSON revisado no pase.

5. Una segunda persona revisa el JSON y el resultado del guard. Con autorización, aplicar exclusivamente el
   plan guardado: `terraform apply "$EVIDENCE_DIR/prepare.tfplan"`. Esperar cero tareas.
6. Generar el plan de destrucción con los mismos variables y volver a obtener el state:

   ```sh
   terraform plan -destroy -var-file=terraform.tfvars -var-file=teardown.tfvars -out="$EVIDENCE_DIR/destroy.tfplan"
   terraform show -json "$EVIDENCE_DIR/destroy.tfplan" > "$EVIDENCE_DIR/destroy-plan.json"
   terraform state pull > "$EVIDENCE_DIR/lab-state-before-destroy.json"
   PLAN_SHA256=$(shasum -a 256 "$EVIDENCE_DIR/destroy.tfplan" | cut -d' ' -f1)
   python3 ../../scripts/lab_teardown_guard.py --mode destroy \
     --identity "$EVIDENCE_DIR/lab-state-identity.json" \
     --backend-metadata .terraform/terraform.tfstate \
     --workspace-file .terraform/environment \
     --state "$EVIDENCE_DIR/lab-state-before-destroy.json" \
     --plan "$EVIDENCE_DIR/destroy-plan.json" \
     --plan-file "$EVIDENCE_DIR/destroy.tfplan" \
     --plan-sha256 "$PLAN_SHA256"
   ```

   El modo `destroy` solo admite eliminaciones de módulos de `lab`, exige verificar directamente RDS con
   `skip_final_snapshot=true`, `final_snapshot_identifier=null` y protección desactivada, exige que el bucket
   SPA y el ALB ya estén preparados (`force_destroy=true`, `enable_deletion_protection=false`), rechaza tipos
   de `bootstrap` o `publisher` y rechaza planes parciales (`-target`) o de otro state: las eliminaciones deben
   coincidir exactamente con las instancias administradas del state obtenido.

## 7. DESTRUIR

1. Aplicar solo el plan de destrucción ya validado desde `infra/terraform/environments/lab`:
   `terraform apply "$EVIDENCE_DIR/destroy.tfplan"`, sin `-auto-approve` y tras comprobar que su SHA-256 es el
   validado. No ejecutar `terraform destroy`
   directo ni regenerar el plan entre la revisión y el apply.
2. Esperar la desactivación de CloudFront y la liberación de ENI de ECS, ALB, endpoints y RDS.
3. Si falla, no repetir a ciegas: identificar el recurso y la dependencia que bloquea.
4. Confirmar que el state remoto de `lab` sigue accesible y no administra recursos.
5. No ejecutar destroy en `bootstrap` ni `publisher`; no borrar imágenes ECR.

Secrets Manager programa la eliminación antes de que Terraform programe las claves de las que depende, pero
la recuperación no es coordinada por Terraform: para recuperar durante la ventana hay que cancelar primero
el borrado de cada CMK y después restaurar los secretos dependientes. Una CMK cuyo plazo venza vuelve
irrecuperables los secretos cifrados. Por eso se usa margen KMS, ciclos con nombres nuevos y no se considera
esta ventana un respaldo.

## 8. VERIFICAR Y CERRAR

Con una autorización posterior de solo lectura:

- inventariar por `Project=spectra-shop`, `Environment=lab` y `LabCycle=<id>`;
- comprobar ALB, endpoints, RDS/snapshots, ECS/tasks, CloudFront, WAF, logs, secretos y CMK;
- documentar secretos y claves en borrado diferido;
- revisar 24-48 horas después costos y almacenamiento residual;
- cerrar el ciclo solo cuando cada residual sea intencional, tenga propietario y fecha de eliminación.

## 9. Fallos que bloquean el cierre

- snapshot RDS manual o final sin política/CMK persistente;
- tarea ECS o ENI activa;
- endpoint, ALB, RDS, CloudFront o WAF no eliminado;
- bucket SPA con versiones;
- log group o alarma huérfana;
- state de `lab` con recursos o lock abandonado;
- recurso sin etiquetas que no pueda atribuirse con seguridad.
