# ADR-AWS-07 — Ciclo reproducible del laboratorio efímero

- **Estado:** Propuesta, pendiente de aprobación formal del propietario. Implementación local verificada
  solo con pruebas simuladas; sin validación en AWS.
- **Fecha:** 2026-11-23.
- **Alcance:** `infra/terraform/environments/lab`; no cambia la propiedad de `bootstrap` ni `publisher`.

## Contexto

Secrets Manager reserva durante su ventana de recuperación los nombres de secretos eliminados. Además, el
snapshot final de RDS quedaría cifrado con la CMK de datos administrada por `lab`; al destruir el entorno se
programaría también el borrado de esa clave, por lo que el snapshot dejaría de ser restaurable.

## Decisiones

1. Cada creación usa un `lab_cycle_id` obligatorio, inmutable mientras exista el ciclo y registrado en
   etiquetas, nombres de secretos y evidencias. No modifica el backend ni los repositorios ECR.
2. La única política de datos es `synthetic-discard`: datos ficticios regenerables mediante migraciones y
   seeds. La raíz `lab` omite incondicionalmente el snapshot final.
3. Los secretos conservan una ventana de recuperación de 7-29 días. Un ciclo nuevo usa otro prefijo, por lo
   que no necesita borrar inmediatamente los secretos anteriores. La ventana KMS es al menos un día mayor
   (14 frente a 7 días por defecto) para dar margen a una recuperación coordinada; no la automatiza.
4. Retener datos exige otro ADR: CMK persistente fuera del state efímero, identificadores únicos, propietario,
   caducidad y costo. No basta con cambiar `skip_final_snapshot`.
5. El apagado se prepara con `teardown_mode=true`, tareas a cero, protección RDS desactivada y bucket SPA
   eliminable. Dos planes guardados se validan contra backend, workspace, lineage, ciclo y allowlists antes
   de aplicar: preparación y destrucción. No se usa un `terraform destroy` directo.
6. Todo `apply` normal (primer despliegue y actualizaciones) usa también un plan guardado validado por el
   mismo guard en modo `deploy`. El guard vincula el plan binario (SHA-256 aprobado, backend, workspace,
   variables, cambios, outputs y state previo embebido con lineage y serial) con su JSON y con el state
   obtenido. Con state vacío solo admite el primer despliegue del ciclo; con state activo rechaza cambiar
   `lab_cycle_id`, planes parciales y eliminar o reemplazar RDS, secretos o claves KMS. No usa
   `terraform_data` ni otros recursos prohibidos por la política del repositorio.
7. `bootstrap` y `publisher` sobreviven a cada ciclo. Nunca se ejecuta un destroy desde esas raíces como parte
   del apagado de `lab`.
8. No se adquiere dominio. El laboratorio usa el nombre `*.cloudfront.net` y el certificado TLS administrado
   por defecto de CloudFront: `domain_name`, `acm_certificate_arn` y `route53_zone_id` permanecen `null`.
9. Se conserva la arquitectura de ADR-AWS-05, el presupuesto mensual de USD 50 y sus avisos. El presupuesto
   es una alarma, no un límite de gasto. El correo real de notificación se reutiliza desde la configuración
   local de `bootstrap`, pero nunca se versiona; si dicha configuración no existe, el despliegue queda
   bloqueado. Se comprobó el 2026-11-24 que la configuración privada de bootstrap contiene
   `budget_emails`. Completar el tfvars privado del lab antes del plan.
10. Todos los datos son sintéticos. `SYNTHETIC_ADMIN_EMAIL` existe en `.env`, pero no es un destinatario de
    presupuesto/alarma y no se reutiliza como tal.
11. Todo rol creado por el state `lab` lleva la permissions boundary preexistente
    `spectra-lab-runtime-boundary`: diez roles de ejecución ECS, el rol de tarea de `identity` y el rol de VPC
    Flow Logs (12 instancias). La boundary está fuera del state efímero, limita el máximo a las API runtime
    exactas y deniega IAM, Organizations, Account y asunción de otros roles. Ni deploy ni teardown pueden
    modificar, eliminar, sustituir o retirar la boundary.
12. Identity Center prepara dos permission sets: `spectra-lab-deployer`, con variantes excluyentes `plan`,
    `deploy` y `teardown`, y `spectra-lab-operator`. Ninguna usa `AdministratorAccess`. `PassRole` se limita a
    los roles runtime del laboratorio y a ECS Tasks/VPC Flow Logs según la operación. Su creación/asignación es manual y queda
    fuera de esta preparación local hasta autorización expresa.
13. La circularidad IAM/plan se resuelve sin privilegios administrativos: inventario estático de recursos y
    roles; `terraform test` con proveedor AWS simulado; primera planificación con la política de solo lectura;
    y promoción temporal a `deploy` o `teardown` únicamente sobre el plan guardado cuyo hash y guard hayan
    sido aprobados. La boundary debe preexistir antes del primer plan real.
14. El `lab_cycle_id` propuesto para el siguiente ciclo es `20261123-a`. Solo se confirma como definitivo al
    demostrar que no existe otro ciclo activo ni residuos con ese identificador; no se cambia durante el ciclo.

## Consecuencias

- Es posible reconstruir antes de que termine la recuperación de secretos del ciclo anterior.
- Se prohíben datos personales, reales o no regenerables en `lab`.
- La recuperación de un secreto antiguo requiere también que su CMK siga recuperable; no se considera un
  mecanismo de backup.
- ECR, state, auditoría y su CMK continúan generando el costo residual intencional documentado.
- La validación AWS real, la facturación y la eliminación completa siguen pendientes de autorización.
- El guard depende del formato de plan de Terraform 1.17.2 (versión fijada en la CI); con otra versión falla
  cerrado hasta verificar el formato y actualizar el guard. Sigue siendo un control procedimental: protege
  solo si el operador aplica exclusivamente el plan validado.
- Desviación académica: se acepta el dominio predeterminado de CloudFront en vez de un dominio institucional;
  no se valida DNS/ACM propio. También se acepta una sola cuenta y asignación manual de permission sets. Estas
  simplificaciones reducen costo y alcance, pero no deben trasladarse sin revisión a producción.
- La denegación de `DeleteRolePermissionsBoundary` debe comprobarse con el plan de destroy simulado y, antes
  de operar, con IAM Policy Simulator: si AWS exigiera retirar la asociación antes de `DeleteRole`, el destroy
  se detendrá de forma segura y requerirá otra decisión aprobada; no se debilita automáticamente el control.
