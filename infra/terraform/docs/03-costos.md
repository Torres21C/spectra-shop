# Estimación de costos del laboratorio (PR-5)

> [!CAUTION]
> **Estimación NO verificada; no es una cotización.** Los precios unitarios son los de referencia del plan de despliegue (§15.1): us-east-1, bajo demanda, sin nivel gratuito, créditos ni impuestos. **No se consultaron precios actuales ni se usó AWS** (no autorizado). Antes de aplicar, recalcule con [AWS Pricing Calculator](https://calculator.aws/) y revise los créditos académicos. Mes = 730 h; 7 días = 168 h.

## 1. Supuestos

- Configuración por defecto del entorno `lab`:
  - Fargate x86: Identity con 0.5 vCPU y 1 GB; Catalog, Commerce y Audit con 0.25 vCPU y 0.5 GB (1.25 vCPU y 2.5 GB en total), una tarea por servicio.
  - `db.t4g.micro` Single-AZ con 20 GB gp3.
  - 5 interface endpoints en **1 AZ**.
  - WAF con 1 ACL y 6 reglas (2 rate-based y 4 grupos administrados).
- Secretos: 8 de rol, 2 tokens, 1 ADMIN sintético y 1 del maestro de RDS (12).
- Claves KMS: datos, JWT y SPA (3), más la del state del bootstrap (1). Desde PR-6.2, ECR cifra con la clave administrada por AWS `aws/ecr` (sin cuota mensual) y los registros de auditoría del state reutilizan la CMK del state: el número de CMK no cambia.
- Tráfico de laboratorio despreciable: dentro del nivel gratuito permanente de CloudFront; de 2 a 4 GB al mes de logs (aplicación, WAF y Flow Logs).
- Sin dominio propio, sin Container Insights, sin Performance Insights y sin Enhanced Monitoring.

## 2. Desglose mensual 24/7

| Componente                                                          | Cálculo de referencia                                                                                 | USD/mes (VERIFICAR) |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| ECS Fargate (x86)                                                   | 1.25 vCPU × 0.04048 × 730 + 2.5 GB × 0.004445 × 730                                                   | ≈ 45.1              |
| Tareas `run-task` (provision, migrate, finalize)                    | Pocos minutos por ejecución                                                                           | < 0.1               |
| VPC interface endpoints                                             | 5 × 0.01 USD/h × 730 (1 AZ) + 0.01 USD/GB                                                             | ≈ 36.5–37           |
| Application Load Balancer                                           | 0.0225 × 730 + LCU                                                                                    | ≈ 17–22             |
| RDS PostgreSQL                                                      | 0.016 × 730 + 20 GB × 0.115 (copias ≤ tamaño de la base: sin cargo)                                   | ≈ 14.0              |
| AWS WAF                                                             | 5 (ACL) + 6 × 1 (reglas) + 0.60 USD/millón de peticiones                                              | ≈ 11                |
| Secrets Manager                                                     | 12 × 0.40                                                                                             | ≈ 4.8               |
| KMS                                                                 | 3 claves del laboratorio + 1 del state; firmas `Sign` de bajo volumen                                 | ≈ 4                 |
| CloudWatch                                                          | Ingesta de logs (≈ 2–4 GB × 0.50), 12 alarmas × 0.10, 4 métricas personalizadas de los filtros × 0.30 | ≈ 3–5               |
| Cloud Map                                                           | Zona privada ≈ 0.50 + 3 instancias × 0.10                                                             | ≈ 0.8               |
| ECR (raíz `publisher`)                                              | ≈ 2–10 GB × 0.10 (hasta 20 imágenes por repositorio); `aws/ecr` sin cuota                             | ≈ 0.2–1             |
| CloudTrail del state (`bootstrap`, PR-6.2)                          | Eventos de datos: 0.10 USD por 100 000 (Terraform genera < 1 000 al mes); registros de KB en S3       | < 0.05              |
| CloudFront                                                          | Nivel gratuito permanente (1 TB y 10 M de peticiones)                                                 | ≈ 0                 |
| S3 (SPA y state)                                                    | Pocos MB                                                                                              | < 0.2               |
| VPC origin, Internet Gateway, gateway S3, SNS, Budgets (2 primeros) | Sin cargo                                                                                             | 0                   |
| IPv4 públicas                                                       | Ninguna                                                                                               | 0                   |
| NAT Gateway                                                         | **No se usa** (alternativa: ≈ 33 + 0.045 USD/GB + IPv4, con salida a Internet)                        | 0                   |
| Transferencia de datos                                              | Entre AZ (ALB ↔ tareas, tareas ↔ endpoint de 1 AZ) y salida, mínima                                   | < 1                 |
| **Total 24/7**                                                      |                                                                                                       | **≈ 136–145**       |

La referencia de **USD 135–140/mes** se conserva: el desglose cae en ese rango por abajo, y el extremo alto (hasta ≈ 145) refleja las 6 reglas de WAF, las métricas personalizadas y la CMK de la SPA añadidas en PR-5.

Variantes:

| Variante                                                              | Diferencia                          |
| --------------------------------------------------------------------- | ----------------------------------- |
| ARM64/Graviton (`cpu_architecture = "ARM64"`, imágenes arm64 en PR-6) | ≈ −9 (Fargate ≈ 20 % menos)         |
| Endpoints en 2 AZ (`interface_endpoint_az_count = 2`)                 | ≈ +36.5                             |
| Container Insights                                                    | Variable (métricas por tarea)       |
| Dominio propio (Route 53)                                             | +0.50 por la zona más las consultas |

## 3. Siete días (ventana de pruebas creada y destruida con IaC)

≈ 136–145 × 7 / 30.4 ≈ **31–34 USD**, más el snapshot final de RDS si se conserva (≈ 20 GB de almacenamiento de snapshot; precio por verificar).

## 4. Qué sigue cobrando aunque ECS esté detenido

Con `service_desired_count = 0` solo se deja de pagar Fargate (≈ 45). **Siguen cobrando ≈ 91–100 USD/mes (≈ 3.0–3.3 USD/día):**

| Sigue cobrando                                          | USD/mes aprox.                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| VPC interface endpoints (por hora y AZ)                 | ≈ 36.5                                                                     |
| ALB (por hora)                                          | ≈ 17                                                                       |
| RDS (instancia + almacenamiento)                        | ≈ 14 (con `stop-db-instance`: ≈ 2.3 de almacenamiento, como máximo 7 días) |
| WAF (ACL y reglas)                                      | ≈ 11                                                                       |
| Secrets Manager                                         | ≈ 4.8                                                                      |
| KMS                                                     | ≈ 4                                                                        |
| CloudWatch (almacenamiento de logs, alarmas y métricas) | ≈ 2–3                                                                      |
| Cloud Map, ECR y S3                                     | ≈ 1–2                                                                      |

## 5. Qué hay que destruir para dejar de pagar

`terraform destroy` del entorno (con autorización; ver README §3.7). Tras la destrucción quedan:

| Residual                                               | Motivo                                                                       | Acción                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Snapshot final de RDS                                  | `synthetic-discard` lo omite; los snapshots manuales están prohibidos en lab | Reconstruir exclusivamente desde migraciones y seeds                     |
| Secretos en la ventana de recuperación (7 días)        | Se borran diferidamente bajo el prefijo del `lab_cycle_id` anterior          | No bloquean el ciclo siguiente; comprobar su estado hasta la eliminación |
| Claves KMS pendientes de borrado (14 días por defecto) | `kms_deletion_window_days`, al menos un día mayor que Secrets Manager        | Verificar si cobran durante la ventana; no confundirla con un backup     |
| Bucket y clave KMS del state (bootstrap)               | `prevent_destroy`                                                            | ≈ 1 USD/mes; se conserva entre ventanas                                  |
| Auditoría del state y presupuesto (bootstrap)          | `prevent_destroy` en el bucket de auditoría; 365 días                        | < 0.05 USD/mes; se conserva entre ventanas                               |
| Repositorios ECR (`publisher`)                         | Raíz aparte; `ecr_force_delete = false`                                      | ≈ 0.1 USD/GB-mes; destruir `lab` no los borra                            |
| Logs ya exportados o copiados fuera                    | —                                                                            | —                                                                        |

## 6. Control

- **AWS Budgets antes del primer recurso:** límite de 50 USD con avisos al 50 % (25 USD) y al 100 % (50 USD) de gasto real, y al 100 % del pronóstico. Con el laboratorio 24/7, el aviso de 25 USD llega en unos 6 días y el de 50 en unos 11: el presupuesto está pensado para ventanas de 7 días.
- **Desde PR-6.2, el presupuesto de la cuenta (`spectra-account-monthly`) se crea con el bootstrap**, la primera raíz que se aplica, y `budget_emails` es obligatorio (D7). Es **un aviso, no un límite de gasto**: AWS Budgets no detiene recursos (no hay acciones configuradas) y sus datos llegan con horas de retraso. El presupuesto del laboratorio (`spectra-lab-monthly`) sigue siendo opcional.
- **Solo la publicación** (bootstrap + `publisher`, sin `lab`): ≈ 2–3 USD/mes (CMK del state ≈ 1, almacenamiento de ECR ≈ 0.1–1, S3 y CloudTrail < 0.3). Sin NAT, ALB, RDS, endpoints, WAF ni CloudFront.
- La prueba P13 compara Cost Explorer con esta estimación tras 24 h.
- Tras cada destroy, el cierre exige inventario inmediato por `LabCycle` y otra comprobación 24–48 h después. Budgets es una alerta retrasada, no un interruptor. Los principales residuos facturables son snapshots manuales, endpoints, ALB, RDS, CloudFront/WAF, log groups o el bucket SPA si la eliminación falla.
