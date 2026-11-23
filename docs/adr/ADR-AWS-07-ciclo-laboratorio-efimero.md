# ADR-AWS-07 — Ciclo reproducible del laboratorio efímero

- **Estado:** Propuesta, pendiente de aprobación formal del propietario. Implementación local verificada
  solo con pruebas simuladas; sin validación en AWS.
- **Fecha:** 2026-11-22.
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
