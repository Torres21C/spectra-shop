# Propuesta de inicio — M06 Administración

- **Fecha:** 2026-11-17
- **Estado:** propuesta para revisión; implementación no iniciada
- **Base técnica:** M06.0 cerrado operativamente en desarrollo local
- **Fuente funcional:** ERS §2.6, RF-030–RF-036 y CA-M06-01–CA-M06-09

## 1. Objetivos

M06 es una capacidad transversal de administración, no un microservicio nuevo. Debe permitir a una sesión `ADMIN`:

- crear, editar, desactivar y reactivar productos;
- ajustar inventario con motivo obligatorio;
- consultar todos los pedidos y filtrarlos por estado;
- aplicar transiciones válidas del ciclo de vida de pedidos;
- mostrar el panel resumen P08 y la gestión de productos P09;
- emitir eventos administrativos sin secretos ni datos innecesarios.

## 2. Dependencias y decisiones previas

| Dependencia                 | Estado                 | Condición para iniciar                                                                                                                                      |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M06.0 / DT-09               | Cumplida en desarrollo | Mantener roles runtime mínimos y ampliar grants/matriz 322 solo junto con nuevas operaciones                                                                |
| M06.0 / DT-08               | Cumplida con límite    | Mantener R27 abierto y no liberar reservas automáticamente                                                                                                  |
| Diseño de cancelación RN-25 | **Bloqueante**         | Resolver la contradicción entre “misma transacción” de la ERS y los límites de microservicios; aprobar o rechazar la adenda de saga idempotente `RESTOCKED` |
| Administrador de prueba     | Pendiente              | Definir creación controlada; nunca mediante registro público                                                                                                |
| Contratos administrativos   | Pendiente              | Aprobar DTO, rutas, paginación, filtros, concurrencia e idempotencia                                                                                        |
| Auditoría M07               | Parcial                | Persistir outbox en M06; la entrega y consulta central siguen en M07                                                                                        |
| R27                         | Abierto                | No condicionar el inicio a su cierre, pero conservar controles y procedimiento manual                                                                       |
| Límites de conexión         | Provisionales          | Dimensionar antes de producción; no introducirlos sin prueba de carga                                                                                       |

## 3. Tareas propuestas

1. Aprobar un ADR de M06 para autorización administrativa, contratos y concurrencia.
2. Resolver RN-25 antes de implementar cancelación; definir compensación, reintentos, idempotencia y estados intermedios si se adopta una saga.
3. Diseñar migraciones aditivas y reversibilidad; no editar migraciones aplicadas.
4. Ampliar `runtime-grants.sql` solo con las operaciones necesarias y actualizar la matriz de aislamiento.
5. Implementar en Catalog las operaciones administrativas de producto e inventario con bloqueo/concurrencia explícitos.
6. Implementar en Commerce la consulta administrativa y las transiciones válidas de pedido, actualizando estado y timestamp coherentemente.
7. Emitir eventos de outbox para RF-030–RF-035 y rechazos de autorización.
8. Implementar P08/P09 con guards de rol, estados de carga/error y texto escapado.
9. Crear pruebas unitarias, integración distribuida, autorización negativa, idempotencia, concurrencia y regresión M01–M05.
10. Ejecutar validación funcional controlada, SAST/SCA, revisión de secretos y evidencia reproducible antes de cualquier despliegue.

## 4. Riesgos principales

| Riesgo                                         | Tratamiento propuesto                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Doble reposición al cancelar                   | Idempotencia por pedido/reserva, transición condicional y pruebas de reintento/concurrencia |
| Estado `CANCELADO` antes de reponer stock      | No publicarlo hasta confirmar `RESTOCKED`; decisión ADR previa                              |
| Ajuste administrativo que compite con checkout | Bloqueo/versión y prueba con reservas simultáneas                                           |
| Exceso de privilegios DT-09                    | Grants explícitos por operación y repetición obligatoria de la matriz de aislamiento        |
| Mass assignment / escalación de rol            | DTO en lista blanca, guard `ADMIN`, pruebas CLIENTE/visitante y auditoría `ACCESS_DENIED`   |
| XSS almacenado                                 | Texto plano, validación de longitud y renderizado React sin HTML crudo                      |
| Pérdida o exposición de auditoría              | Outbox transaccional con metadatos permitidos; sin tokens, cookies ni secretos              |
| Downgrade incompatible                         | Migraciones aditivas, corrección hacia adelante y respaldo restaurable antes de aplicar     |

## 5. Criterios de aceptación para autorizar cierre de M06

- CA-M06-01–CA-M06-09 ejecutados con evidencia; ningún SKIP se contabiliza como PASS.
- RF-030–RF-036 implementados sin ampliar el registro público ni crear un servicio nuevo.
- Una cuenta CLIENTE recibe 403 en toda ruta administrativa; visitante recibe 401.
- Las transiciones RN-24 y sus timestamps se validan integralmente, completando CA-M05-04.
- Cancelación, si se autoriza, repone exactamente una vez bajo reintento y concurrencia.
- Auditoría contiene actor, recurso y diferencias permitidas, sin secretos.
- Roles runtime conservan mínimo privilegio y la matriz actualizada pasa al 100 %.
- Regresión M01–M05, Web, SAST/SCA y prueba de respaldo/restauración pasan.
- R27, límites de conexión y cualquier cobertura SKIP se reportan explícitamente.

## 6. Puerta de inicio

La implementación solo debe comenzar tras una autorización explícita que defina al menos: alcance de cancelación/RN-25, estrategia de rama, datos administrativos de prueba y criterios de evidencia. Esta propuesta no crea rama, código, migraciones, credenciales ni datos.
