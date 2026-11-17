# Cierre operativo de M06.0 — DT-09 y DT-08

- **Fecha:** 2026-11-17
- **Entorno:** desarrollo local
- **Código validado:** `main` = `origin/main` = `49785d047107938b2c45803c8c6a68a4a70bcc6e`
- **Estado:** cierre operativo autorizado y documentado; M06 funcional no iniciado
- **Riesgo R27:** **ABIERTO**

## 1. Alcance del cierre

Este cierre confirma que los prerrequisitos técnicos M06.0 fueron integrados, aplicados y validados sobre la base principal local de desarrollo:

- **DT-09:** roles PostgreSQL migradores y runtime separados para Identity, Catalog y Commerce, con privilegios mínimos y cierre de la ventana temporal de migración.
- **DT-08:** reconocimiento idempotente de reservas mediante `FULFILLED`, recuperación del reconocimiento y detección de reservas confirmadas sin vínculo reconocido.

El cierre no aprueba las adendas RN-25 o DT-08/R27, no cierra R27, no inicia M06 funcional y no constituye despliegue AWS, DAST ni cierre de las fases académicas 3 o 4.

## 2. Estado final verificado

| Elemento              | Resultado                                                                           |
| --------------------- | ----------------------------------------------------------------------------------- |
| Git                   | `main` y `origin/main` en `49785d0`; limpio antes del cierre documental             |
| Servicios principales | PostgreSQL, Identity, Catalog, Commerce y Web saludables; 0 reinicios               |
| Identity              | 45 usuarios                                                                         |
| Commerce              | 5 pedidos; pedido controlado `SP-10526`                                             |
| Catalog               | 5 reservas `FULFILLED`                                                              |
| DT-08                 | 5 intentos con `inventory_fulfilled_at`; 0 pendientes, errores, reintentos o leases |
| Integridad            | 0 pedidos, intentos o reservas huérfanos                                            |
| Secuencia             | `commerce.order_number_seq = 10526`                                                 |
| Producto controlado   | `20000000-0000-4000-8000-000000000011`; stock 13                                    |

## 3. Matriz final de aceptación

| Criterio                                  | Estado | Evidencia resumida                                                                                               |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Respaldo previo verificable y restaurable | PASS   | `pg_dump -Fc`, globals, SHA-256, restauración PostgreSQL 16.6 aislada y 18 tablas coincidentes                   |
| `postgres-provision`                      | PASS   | Código de salida 0                                                                                               |
| Migración Identity                        | PASS   | Código 0; 1 migración total; 0 fallidas                                                                          |
| Migraciones Catalog                       | PASS   | Código 0; 4 migraciones totales; 0 fallidas                                                                      |
| Migraciones Commerce                      | PASS   | Código 0; 5 migraciones totales; 0 fallidas                                                                      |
| `postgres-finalize`                       | PASS   | Código 0; privilegios temporales revocados                                                                       |
| Aislamiento DT-09                         | PASS   | 322/322 controles                                                                                                |
| Roles runtime                             | PASS   | Sin superusuario, `CREATE`, `TEMP`, `CREATEDB` ni `CREATEROLE`                                                   |
| Reconciliación histórica DT-08            | PASS   | 4/4 pedidos vinculados; reservas `FULFILLED`; inventario histórico sin cambios                                   |
| Arranque controlado                       | PASS   | Cinco servicios saludables, imágenes M06.0 esperadas y 0 reinicios                                               |
| Validación Web                            | PASS   | SPA y recursos 200; Identity/Catalog/Commerce disponibles; CORS correcto; 0 HTTP 5xx inesperados                 |
| Registro y login                          | PASS   | Un usuario nuevo; registro 201, login 201 y `/auth/me` 200                                                       |
| Checkout controlado                       | PASS   | Un pedido `SP-10526`, un intento y una reserva vinculada                                                         |
| Idempotencia                              | PASS   | Reenvío 200 con la misma clave y pedido; sin pedido ni descuento adicional                                       |
| Inventario                                | PASS   | Stock del producto controlado 14 → 13 exactamente una vez                                                        |
| Reconocimiento inmediato DT-08            | PASS   | Reserva `FULFILLED`, `inventory_fulfilled_at`, 0 reintentos/errores/leases                                       |
| Integridad histórica posterior            | PASS   | Hashes exactos de los 4 pedidos, ítems, intentos, reservas y líneas previos                                      |
| Stock insuficiente                        | SKIP   | No era reproducible sin alterar inventario o introducir concurrencia fuera del alcance; no se considera validado |

## 4. Evidencias consolidadas

| Grupo                 | Ubicación / referencia                                                                      | Contenido                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Implementación y CI   | Bóveda: `EV-M06-0-MERGE-MAIN-CI-43999993404`                                                | PR #7, merge manual, CI de `main`, regresión y controles de seguridad                        |
| DT-09 local           | Bóveda: `EV-M06-0-DT09-ISOLATION-LOCAL-20261116` y `EV-M06-0-DT09-MIGRATION-LOCAL-20261116` | 322/322, volumen nuevo, copia restaurada y reversión de privilegios ensayada                 |
| DT-08 local           | Bóveda: `EV-M06-0-DT08-FULFILL-LOCAL-20261116`                                              | Contrato, idempotencia, recuperación, alertas y detección                                    |
| Endurecimiento        | Bóveda: `EV-M06-0-HARDENING-LOCAL-20261116` y `EV-M06-0-FLAKY-FIX-LOCAL-20261117`           | Seed idempotente, ramas de error y estabilización de pruebas                                 |
| Aplicación controlada | `~/spectra-backups/m06-0/pre-apply-20261116-215645/`                                        | Migraciones, roles, ACL, integridad, 322/322, reconciliación, arranque y Web                 |
| Prueba transaccional  | `~/spectra-backups/m06-0/pre-transaction-20261117-103333/`                                  | Respaldo/restauración, registro, login, checkout, idempotencia, DT-08 y hashes antes/después |
| Cierre documental     | Bóveda: `EV-M06-0-CIERRE-OPERATIVO-LOCAL-20261117`                                          | Índice de este cierre y recursos conservados                                                 |

Los respaldos, manifiestos, contenedores y volúmenes se conservan. Los archivos sensibles permanecen fuera del repositorio y con permisos restrictivos.

## 5. Registros de prueba conservados

| Tipo     | Identificador                                       |
| -------- | --------------------------------------------------- |
| Usuario  | `2bb5ba68-ea8a-4c00-be0c-43f654ba43c6`              |
| Pedido   | `205a5aa5-ceb7-4b7d-8ba2-5ab9011ab2f4` (`SP-10526`) |
| Intento  | `72353b61-8dd1-4d7f-b271-fe4597ca47fe`              |
| Reserva  | `03cc262a-690a-4a0c-81e2-66162f4d4553`              |
| Producto | `20000000-0000-4000-8000-000000000011`              |

No se autoriza su eliminación como parte de este cierre.

## 6. Riesgos y limitaciones residuales

1. **R27 permanece ABIERTO.** DT-08 detecta el caso de una reserva confirmada que Commerce no puede recuperar, pero la resolución continúa siendo manual.
2. **RN-25 y DT-08/R27 siguen como adendas propuestas.** La evidencia operativa no equivale a su aprobación académica o funcional.
3. **`CONNECTION LIMIT -1` es provisional para desarrollo.** Los límites por rol de producción siguen sin dimensionar.
4. **No existe downgrade directo seguro al código anterior.** Tras persistir estados `FULFILLED` y las columnas M06.0, el código previo puede no comprender el esquema o los estados. El rollback de DT-09 solo revierte propiedad y roles; no deshace DT-08. Una recuperación requiere corrección hacia adelante o restauración controlada en una base nueva, con autorización y verificación.
5. **Stock insuficiente quedó SKIP.** No debe presentarse como PASS ni como cobertura aprobada.
6. **Recursos locales conservados.** Permanecen respaldos, restauraciones aisladas, proyectos Compose y volúmenes temporales; requieren una autorización separada para su limpieza.
7. **Alcances pendientes:** M06 funcional, M07/DT-10, CSP productiva, DAST/ZAP, AWS y reevaluación formal de riesgos.

## 7. Decisión de cierre

M06.0 queda **cerrado operativamente en el entorno local de desarrollo**: DT-08 y DT-09 fueron implementados, migrados y validados. Este estado habilita solicitar el inicio de M06 funcional, pero no lo inicia ni autoriza cambios de aplicación.
