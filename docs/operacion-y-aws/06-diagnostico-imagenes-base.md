# Diagnóstico de vulnerabilidades de las imágenes base (R-PR6-10)

> [!IMPORTANT]
> Es solo un diagnóstico: **no modifica Dockerfiles, imágenes ni la política de vulnerabilidades, y no añade excepciones.** La corrección se propone como un PR independiente (sección 5), pendiente de la decisión del propietario.

## 1. Método

- Imágenes: las 9 que construye `scripts/ecr/build-images.sh` sobre el commit `15f4139` (rama de PR-6). Su contenido es el de `main` = `0e3758c`, porque los Dockerfiles solo copian `apps/`, `packages/` e `infra/postgres`. Plataforma `linux/amd64`.
- Herramienta: Trivy 0.76.2 (`--scanners vuln,secret`), base de datos de vulnerabilidades del 2026-11-21T18:38:32Z. Política aprobada el 2026-11-21: CRITICAL y HIGH con corrección bloquean.
- Evidencia: `EV-AWS-PR6-PIPELINE-LOCAL-20261121` (bóveda), en `04-analisis/*.trivy.json`.

## 2. Resumen

| Medida                                                 | Valor                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Hallazgos bloqueantes (suma de las 9 imágenes)         | **615** (47 CRITICAL y 568 HIGH)                                                       |
| Hallazgos únicos (CVE, paquete)                        | **124**                                                                                |
| CVE distintos                                          | 111                                                                                    |
| Repetidos (el mismo CVE y paquete en varias imágenes)  | 491                                                                                    |
| Sin versión corregida                                  | **0**: todos tienen corrección, así que la política no admite excepciones para ninguno |
| En dependencias de la aplicación (`/app/node_modules`) | **0**                                                                                  |

| Origen                          | Hallazgos únicos | Imágenes afectadas                                             |
| ------------------------------- | ---------------: | -------------------------------------------------------------- |
| gosu (Go) de la imagen postgres |               60 | db-ops                                                         |
| Alpine (paquetes del SO)        |               43 | au-mg, au-rt, ca-mg, ca-rt, co-mg, co-rt, db-ops, id-mg, id-rt |
| CLI npm de la imagen node       |               21 | au-mg, au-rt, ca-mg, ca-rt, co-mg, co-rt, id-mg, id-rt         |

Por imagen (todas las severidades):

| Imagen                     | CRITICAL | HIGH | MEDIUM | LOW |
| -------------------------- | -------: | ---: | -----: | --: |
| `identity-service-runtime` |        5 |   59 |     61 |  38 |
| `identity-service-migrate` |        5 |   59 |     61 |  38 |
| `catalog-service-runtime`  |        5 |   59 |     61 |  38 |
| `catalog-service-migrate`  |        5 |   59 |     61 |  38 |
| `commerce-service-runtime` |        5 |   59 |     61 |  38 |
| `commerce-service-migrate` |        5 |   59 |     61 |  38 |
| `audit-service-runtime`    |        5 |   59 |     61 |  38 |
| `audit-service-migrate`    |        5 |   59 |     61 |  38 |
| `db-ops`                   |        7 |   96 |    107 |  43 |

Las 8 imágenes de servicio tienen los mismos 64 hallazgos bloqueantes: los de su imagen base `node:22.14.0-alpine3.21` (Alpine 3.21.3, **fuera de soporte**). `db-ops` hereda 103 de `postgres:16.6-alpine` (Alpine 3.21.2 y el binario `gosu`, escrito en Go).

## 3. Hallazgos únicos

Abreviaturas de imagen: `id`, `ca`, `co` y `au` = identity, catalog, commerce y audit; `rt` = runtime; `mg` = migrate.

### Alpine (paquetes del SO) (43)

| CVE             | Severidad | Paquete      | Versión instalada  | Versión corregida | ¿Fix? | Imágenes | Ocurrencias |
| --------------- | --------- | ------------ | ------------------ | ----------------- | ----- | -------- | ----------: |
| CVE-2026-31789  | CRITICAL  | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-31789  | CRITICAL  | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2024-56171  | CRITICAL  | `libxml2`    | 2.13.4-r3          | 2.13.4-r4         | sí    | db-ops   |           1 |
| CVE-2024-12797  | HIGH      | `libcrypto3` | 3.3.2-r4           | 3.3.3-r0          | sí    | db-ops   |           1 |
| CVE-2025-15467  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.6-r0          | sí    | las 9    |           9 |
| CVE-2025-69421  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.6-r0          | sí    | las 9    |           9 |
| CVE-2026-28387  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28388  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28389  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28390  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-45447  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r1          | sí    | las 9    |           9 |
| CVE-2026-84782  | HIGH      | `libcrypto3` | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r2          | sí    | las 9    |           9 |
| CVE-2024-12797  | HIGH      | `libssl3`    | 3.3.2-r4           | 3.3.3-r0          | sí    | db-ops   |           1 |
| CVE-2025-15467  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.6-r0          | sí    | las 9    |           9 |
| CVE-2025-69421  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.6-r0          | sí    | las 9    |           9 |
| CVE-2026-28387  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28388  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28389  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-28390  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r0          | sí    | las 9    |           9 |
| CVE-2026-45447  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r1          | sí    | las 9    |           9 |
| CVE-2026-84782  | HIGH      | `libssl3`    | 3.3.2-r4, 3.3.3-r0 | 3.3.7-r2          | sí    | las 9    |           9 |
| CVE-2025-24928  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.4-r4         | sí    | db-ops   |           1 |
| CVE-2025-27113  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.4-r5         | sí    | db-ops   |           1 |
| CVE-2025-32414  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.4-r6         | sí    | db-ops   |           1 |
| CVE-2025-32415  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.4-r6         | sí    | db-ops   |           1 |
| CVE-2025-49794  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.9-r0         | sí    | db-ops   |           1 |
| CVE-2025-49795  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.9-r0         | sí    | db-ops   |           1 |
| CVE-2025-49796  | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.9-r0         | sí    | db-ops   |           1 |
| CVE-2026-6732   | HIGH      | `libxml2`    | 2.13.4-r3          | 2.13.9-r1         | sí    | db-ops   |           1 |
| CVE-2024-55549  | HIGH      | `libxslt`    | 1.1.42-r1          | 1.1.42-r2         | sí    | db-ops   |           1 |
| CVE-2025-24855  | HIGH      | `libxslt`    | 1.1.42-r1          | 1.1.42-r2         | sí    | db-ops   |           1 |
| CVE-2026-125350 | HIGH      | `libxslt`    | 1.1.42-r1          | 1.1.42-r3         | sí    | db-ops   |           1 |
| CVE-2026-87636  | HIGH      | `libxslt`    | 1.1.42-r1          | 1.1.42-r3         | sí    | db-ops   |           1 |
| CVE-2026-9947   | HIGH      | `libxslt`    | 1.1.42-r1          | 1.1.42-r3         | sí    | db-ops   |           1 |
| CVE-2025-26519  | HIGH      | `musl`       | 1.2.5-r8           | 1.2.5-r9          | sí    | db-ops   |           1 |
| CVE-2026-107891 | HIGH      | `musl`       | 1.2.5-r8, 1.2.5-r9 | 1.2.5-r12         | sí    | las 9    |           9 |
| CVE-2026-40200  | HIGH      | `musl`       | 1.2.5-r8, 1.2.5-r9 | 1.2.5-r11         | sí    | las 9    |           9 |
| CVE-2025-26519  | HIGH      | `musl-utils` | 1.2.5-r8           | 1.2.5-r9          | sí    | db-ops   |           1 |
| CVE-2026-107891 | HIGH      | `musl-utils` | 1.2.5-r8, 1.2.5-r9 | 1.2.5-r12         | sí    | las 9    |           9 |
| CVE-2026-40200  | HIGH      | `musl-utils` | 1.2.5-r8, 1.2.5-r9 | 1.2.5-r11         | sí    | las 9    |           9 |
| CVE-2025-31115  | HIGH      | `xz-libs`    | 5.6.3-r0           | 5.6.3-r1          | sí    | db-ops   |           1 |
| CVE-2026-22184  | HIGH      | `zlib`       | 1.3.1-r2           | 1.3.2-r0          | sí    | las 9    |           9 |
| CVE-2026-85091  | HIGH      | `zlib`       | 1.3.1-r2           | 1.3.2-r1          | sí    | las 9    |           9 |

### CLI npm de la imagen node (21)

| CVE             | Severidad | Paquete           | Versión instalada | Versión corregida                                       | ¿Fix? | Imágenes          | Ocurrencias |
| --------------- | --------- | ----------------- | ----------------- | ------------------------------------------------------- | ----- | ----------------- | ----------: |
| CVE-2026-59873  | CRITICAL  | `tar`             | 6.2.1, 7.4.3      | 7.5.19                                                  | sí    | las 8 de servicio |          24 |
| CVE-2026-102276 | HIGH      | `brace-expansion` | 2.0.1             | 5.0.10, 3.0.7, 2.1.5, 1.1.19                            | sí    | las 8 de servicio |           8 |
| CVE-2026-102278 | HIGH      | `brace-expansion` | 2.0.1             | 5.0.11, 3.0.8, 2.1.6, 1.1.20                            | sí    | las 8 de servicio |           8 |
| CVE-2026-13149  | HIGH      | `brace-expansion` | 2.0.1             | 5.0.7, 1.1.16, 2.1.2                                    | sí    | las 8 de servicio |           8 |
| CVE-2026-14257  | HIGH      | `brace-expansion` | 2.0.1             | 5.0.8, 3.0.3, 2.1.3, 1.1.17                             | sí    | las 8 de servicio |           8 |
| CVE-2026-69152  | HIGH      | `brace-expansion` | 2.0.1             | 1.1.18, 2.1.4, 3.0.6, 5.0.9                             | sí    | las 8 de servicio |           8 |
| CVE-2025-64756  | HIGH      | `glob`            | 10.4.5            | 11.1.0, 10.5.0                                          | sí    | las 8 de servicio |           8 |
| CVE-2026-69192  | HIGH      | `ip-address`      | 9.0.5             | 10.3.1                                                  | sí    | las 8 de servicio |           8 |
| CVE-2026-26996  | HIGH      | `minimatch`       | 9.0.5             | 10.2.1, 9.0.6, 8.0.5, 7.4.7, 6.2.1, 5.1.7, 4.2.4, 3.1.3 | sí    | las 8 de servicio |           8 |
| CVE-2026-27903  | HIGH      | `minimatch`       | 9.0.5             | 10.2.3, 9.0.7, 8.0.6, 7.4.8, 6.2.2, 5.1.8, 4.2.5, 3.1.3 | sí    | las 8 de servicio |           8 |
| CVE-2026-27904  | HIGH      | `minimatch`       | 9.0.5             | 10.2.3, 9.0.7, 8.0.6, 7.4.8, 6.2.2, 5.1.8, 4.2.5, 3.1.4 | sí    | las 8 de servicio |           8 |
| CVE-2026-9496   | HIGH      | `pacote`          | 19.0.1, 20.0.0    | 21.5.1                                                  | sí    | las 8 de servicio |          16 |
| CVE-2026-48815  | HIGH      | `sigstore`        | 3.0.0             | 4.1.1                                                   | sí    | las 8 de servicio |           8 |
| CVE-2026-23745  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.3                                                   | sí    | las 8 de servicio |          24 |
| CVE-2026-23950  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.4                                                   | sí    | las 8 de servicio |          24 |
| CVE-2026-24842  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.7                                                   | sí    | las 8 de servicio |          24 |
| CVE-2026-26960  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.8                                                   | sí    | las 8 de servicio |          24 |
| CVE-2026-29786  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.10                                                  | sí    | las 8 de servicio |          24 |
| CVE-2026-31802  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.11                                                  | sí    | las 8 de servicio |          24 |
| CVE-2026-59874  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.18                                                  | sí    | las 8 de servicio |          24 |
| CVE-2026-73566  | HIGH      | `tar`             | 6.2.1, 7.4.3      | 7.5.21                                                  | sí    | las 8 de servicio |          24 |

### gosu (Go) de la imagen postgres (60)

| CVE             | Severidad | Paquete  | Versión instalada | Versión corregida                | ¿Fix? | Imágenes | Ocurrencias |
| --------------- | --------- | -------- | ----------------- | -------------------------------- | ----- | -------- | ----------: |
| CVE-2023-24538  | CRITICAL  | `stdlib` | v1.18.2           | 1.19.8, 1.20.3                   | sí    | db-ops   |           1 |
| CVE-2023-24540  | CRITICAL  | `stdlib` | v1.18.2           | 1.19.9, 1.20.4                   | sí    | db-ops   |           1 |
| CVE-2024-24790  | CRITICAL  | `stdlib` | v1.18.2           | 1.21.11, 1.22.4                  | sí    | db-ops   |           1 |
| CVE-2025-68121  | CRITICAL  | `stdlib` | v1.18.2           | 1.24.13, 1.25.7, 1.26.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2022-27664  | HIGH      | `stdlib` | v1.18.2           | 1.18.6, 1.19.1                   | sí    | db-ops   |           1 |
| CVE-2022-28131  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-2879   | HIGH      | `stdlib` | v1.18.2           | 1.18.7, 1.19.2                   | sí    | db-ops   |           1 |
| CVE-2022-2880   | HIGH      | `stdlib` | v1.18.2           | 1.18.7, 1.19.2                   | sí    | db-ops   |           1 |
| CVE-2022-29804  | HIGH      | `stdlib` | v1.18.2           | 1.17.11, 1.18.3                  | sí    | db-ops   |           1 |
| CVE-2022-30580  | HIGH      | `stdlib` | v1.18.2           | 1.17.11, 1.18.3                  | sí    | db-ops   |           1 |
| CVE-2022-30630  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-30631  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-30632  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-30633  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-30634  | HIGH      | `stdlib` | v1.18.2           | 1.17.11, 1.18.3                  | sí    | db-ops   |           1 |
| CVE-2022-30635  | HIGH      | `stdlib` | v1.18.2           | 1.17.12, 1.18.4                  | sí    | db-ops   |           1 |
| CVE-2022-32189  | HIGH      | `stdlib` | v1.18.2           | 1.17.13, 1.18.5                  | sí    | db-ops   |           1 |
| CVE-2022-41715  | HIGH      | `stdlib` | v1.18.2           | 1.18.7, 1.19.2                   | sí    | db-ops   |           1 |
| CVE-2022-41716  | HIGH      | `stdlib` | v1.18.2           | 1.18.8, 1.19.3                   | sí    | db-ops   |           1 |
| CVE-2022-41720  | HIGH      | `stdlib` | v1.18.2           | 1.18.9, 1.19.4                   | sí    | db-ops   |           1 |
| CVE-2022-41722  | HIGH      | `stdlib` | v1.18.2           | 1.19.6, 1.20.1                   | sí    | db-ops   |           1 |
| CVE-2022-41723  | HIGH      | `stdlib` | v1.18.2           | 1.19.6, 1.20.1                   | sí    | db-ops   |           1 |
| CVE-2022-41724  | HIGH      | `stdlib` | v1.18.2           | 1.19.6, 1.20.1                   | sí    | db-ops   |           1 |
| CVE-2022-41725  | HIGH      | `stdlib` | v1.18.2           | 1.19.6, 1.20.1                   | sí    | db-ops   |           1 |
| CVE-2023-24534  | HIGH      | `stdlib` | v1.18.2           | 1.19.8, 1.20.3                   | sí    | db-ops   |           1 |
| CVE-2023-24536  | HIGH      | `stdlib` | v1.18.2           | 1.19.8, 1.20.3                   | sí    | db-ops   |           1 |
| CVE-2023-24537  | HIGH      | `stdlib` | v1.18.2           | 1.19.8, 1.20.3                   | sí    | db-ops   |           1 |
| CVE-2023-24539  | HIGH      | `stdlib` | v1.18.2           | 1.19.9, 1.20.4                   | sí    | db-ops   |           1 |
| CVE-2023-29400  | HIGH      | `stdlib` | v1.18.2           | 1.19.9, 1.20.4                   | sí    | db-ops   |           1 |
| CVE-2023-29403  | HIGH      | `stdlib` | v1.18.2           | 1.19.10, 1.20.5                  | sí    | db-ops   |           1 |
| CVE-2023-39325  | HIGH      | `stdlib` | v1.18.2           | 1.20.10, 1.21.3                  | sí    | db-ops   |           1 |
| CVE-2023-45283  | HIGH      | `stdlib` | v1.18.2           | 1.20.11, 1.21.4, 1.20.12, 1.21.5 | sí    | db-ops   |           1 |
| CVE-2023-45287  | HIGH      | `stdlib` | v1.18.2           | 1.20.0                           | sí    | db-ops   |           1 |
| CVE-2023-45288  | HIGH      | `stdlib` | v1.18.2           | 1.21.9, 1.22.2                   | sí    | db-ops   |           1 |
| CVE-2024-34156  | HIGH      | `stdlib` | v1.18.2           | 1.22.7, 1.23.1                   | sí    | db-ops   |           1 |
| CVE-2025-61726  | HIGH      | `stdlib` | v1.18.2           | 1.24.12, 1.25.6                  | sí    | db-ops   |           1 |
| CVE-2025-61729  | HIGH      | `stdlib` | v1.18.2           | 1.24.11, 1.25.5                  | sí    | db-ops   |           1 |
| CVE-2026-111943 | HIGH      | `stdlib` | v1.18.2           | 1.26.10, 1.27.3                  | sí    | db-ops   |           1 |
| CVE-2026-25679  | HIGH      | `stdlib` | v1.18.2           | 1.25.8, 1.26.1                   | sí    | db-ops   |           1 |
| CVE-2026-27145  | HIGH      | `stdlib` | v1.18.2           | 1.25.11, 1.26.4                  | sí    | db-ops   |           1 |
| CVE-2026-32280  | HIGH      | `stdlib` | v1.18.2           | 1.25.9, 1.26.2                   | sí    | db-ops   |           1 |
| CVE-2026-32281  | HIGH      | `stdlib` | v1.18.2           | 1.25.9, 1.26.2                   | sí    | db-ops   |           1 |
| CVE-2026-32283  | HIGH      | `stdlib` | v1.18.2           | 1.25.9, 1.26.2                   | sí    | db-ops   |           1 |
| CVE-2026-33811  | HIGH      | `stdlib` | v1.18.2           | 1.25.10, 1.26.3                  | sí    | db-ops   |           1 |
| CVE-2026-33814  | HIGH      | `stdlib` | v1.18.2           | 1.25.10, 1.26.3                  | sí    | db-ops   |           1 |
| CVE-2026-33818  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-39820  | HIGH      | `stdlib` | v1.18.2           | 1.25.10, 1.26.3                  | sí    | db-ops   |           1 |
| CVE-2026-39821  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-39822  | HIGH      | `stdlib` | v1.18.2           | 1.25.12, 1.26.5, 1.27.0-rc.2     | sí    | db-ops   |           1 |
| CVE-2026-39836  | HIGH      | `stdlib` | v1.18.2           | 1.25.10, 1.26.3                  | sí    | db-ops   |           1 |
| CVE-2026-42499  | HIGH      | `stdlib` | v1.18.2           | 1.25.10, 1.26.3                  | sí    | db-ops   |           1 |
| CVE-2026-42504  | HIGH      | `stdlib` | v1.18.2           | 1.25.11, 1.26.4                  | sí    | db-ops   |           1 |
| CVE-2026-56853  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-56858  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-56859  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-56860  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-56862  | HIGH      | `stdlib` | v1.18.2           | 1.25.13, 1.26.6, 1.27.0-rc.3     | sí    | db-ops   |           1 |
| CVE-2026-78667  | HIGH      | `stdlib` | v1.18.2           | 1.26.9, 1.27.2                   | sí    | db-ops   |           1 |
| CVE-2026-78669  | HIGH      | `stdlib` | v1.18.2           | 1.26.9, 1.27.2                   | sí    | db-ops   |           1 |
| CVE-2026-97031  | HIGH      | `stdlib` | v1.18.2           | 1.26.9, 1.27.2                   | sí    | db-ops   |           1 |

## 4. Imágenes base candidatas (análisis sin construir)

Trivy 0.76.2 sobre las imágenes base publicadas (`linux/amd64`, misma base de datos, solo CRITICAL y HIGH). El análisis «sin npm/yarn» simula su retirada con `--skip-dirs /usr/local/lib/node_modules/npm`, `…/corepack` y `/opt`.

| Imagen base                                               | Alpine | Fuera de soporte | CRITICAL |  HIGH | Origen                    |
| --------------------------------------------------------- | ------ | ---------------- | -------: | ----: | ------------------------- |
| `node:22.14.0-alpine3.21` (actual)                        | 3.21.3 | **sí**           |        5 |    59 | CLI de npm (40) y SO (24) |
| `postgres:16.6-alpine` (actual, `db-ops`)                 | 3.21.2 | **sí**           |        7 |    96 | `gosu` (60) y SO (43)     |
| `node:22.23.5-alpine3.24@sha256:1314fb30…` (2026-11-12)   | 3.24.4 | no               |        0 |    10 | Solo el CLI de npm        |
| La misma, **sin npm, corepack ni yarn**                   | 3.24.4 | no               |    **0** | **0** | —                         |
| `postgres:16.16-alpine3.24@sha256:1d5b02d3…` (2026-11-19) | 3.24.4 | no               |        1 |    26 | `gosu` (26) y SO (1)      |
| `alpine:3.24.4@sha256:f59abe65…` (2026-11-08)             | 3.24.4 | no               |    **0** | **0** | —                         |

Conclusiones:

- Actualizar la imagen base elimina todos los hallazgos de Alpine.
- Retirar las herramientas de paquetes de las etapas finales elimina los del CLI de npm.
- La imagen del servidor `postgres` trae `gosu`, que `db-ops` no usa (solo ejecuta `psql`). Una imagen mínima sobre `alpine` con el cliente evita esos hallazgos.

## 5. Propuesta: PR independiente «PR-6.1: imágenes base»

**No implementado.** Requiere autorización: cambia los Dockerfiles, que también usa el stack local de Compose.

1. **Servicios (4 Dockerfiles):**
   - `FROM node:22.23.5-alpine3.24@sha256:<digest del índice>` en todas las etapas.
   - Fijar el digest el día del PR y preferir una publicación con unos días de antigüedad.
   - Es un cambio de versión menor de Node 22 (22.14 → 22.23); hay que pasar la regresión completa.
2. **Etapas `runtime` y `migrate`:** retirar el gestor de paquetes antes de `USER node`:

   ```dockerfile
   RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
         /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
         /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
   ```

   Comprobado en el código: las migraciones en AWS (`infra/terraform/modules/ecs/workloads.tf`) y en Compose (`compose.yaml`) usan `./node_modules/.bin/prisma` y `node`, nunca npm. Las pruebas de Compose (`npm test`) usan la etapa `build`, que mantiene npm.

3. **`db-ops` mínimo:**
   - `FROM alpine:3.24.4@sha256:…` con `apk add --no-cache postgresql16-client=<versión fijada>`.
   - Usuario sin privilegios, los mismos scripts SQL de solo lectura (`0444`) y el mismo `CMD`.
   - Sin el servidor PostgreSQL ni `gosu`.
4. **Validación del PR:**
   - CI completa: integración con DT-09 492/492 en Compose y con emulación RDS, y suites de los 4 servicios.
   - Smoke del stack en un proyecto Compose desechable.
   - Ensayo del pipeline con `publish = false` cuando `ecr-publish` esté en `main`.
   - Resultado esperado: 0 bloqueos, o solo hallazgos sin corrección, que se analizarían uno a uno.
5. **Riesgos:**
   - Comportamiento de Node 22.23 y de OpenSSL 3.x de Alpine 3.24 con los motores de Prisma (los detecta automáticamente; probar).
   - Si la versión de `postgresql16-client` disponible es distinta, comprobar `psql` contra RDS 16 (P7).
   - La imagen `postgres:16.6-alpine` del PostgreSQL de Compose y de la CI no se publica en ECR y queda fuera de este PR. Su actualización afecta a la base del stack principal y exige una decisión aparte.

## 6. Lo que no se hace

- **No se añade ninguna excepción:** los 124 hallazgos únicos tienen versión corregida, así que la política aprobada no admite excepción para ninguno. Tampoco se cambia la política para obtener una ejecución en verde.
- No se publican imágenes ni se cambian los Dockerfiles en PR-6.

## 7. Resultado de la remediación (PR-6.1, 2026-11-21, local)

Rama `feature/aws-pr6-1-base-images` (commit `e5d87be`, PR #19). Antes = imágenes de `main` (bases actuales); después = PR-6.1. Las 9 imágenes `linux/amd64` construidas con `scripts/ecr/build-images.sh` y analizadas con `scripts/ecr/scan-images.sh` (Trivy 0.76.2), **con la política sin cambios y sin excepciones**.

| Imagen                     | Base antes → después                                                                                   | Digest después         | Tamaño antes → después | CRITICAL  | HIGH       | Paquetes eliminados                                 | Arranque o migración                             | Trivy y SBOM                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------- | --------- | ---------- | --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `identity-service-runtime` | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:2e3977a08ace…` | 89.8 → 95.9 MB         | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Arranca; `/health` y `/health/ready` 200         | Política: pasa · MEDIUM/LOW 7/4 · SBOM 388 → 170 componentes |
| `identity-service-migrate` | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:acc69b177398…` | 147.2 → 153.3 MB       | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Migraciones Prisma OK (Compose y emulación RDS)  | Política: pasa · MEDIUM/LOW 7/4 · SBOM 434 → 216 componentes |
| `catalog-service-runtime`  | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:24800cbfd527…` | 87.7 → 93.8 MB         | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Arranca; `/health` y `/health/ready` 200         | Política: pasa · MEDIUM/LOW 7/4 · SBOM 353 → 135 componentes |
| `catalog-service-migrate`  | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:95f99e9972ed…` | 145.1 → 151.2 MB       | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Migraciones Prisma OK (Compose y emulación RDS)  | Política: pasa · MEDIUM/LOW 7/4 · SBOM 399 → 181 componentes |
| `commerce-service-runtime` | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:e170cfefd84a…` | 88.2 → 94.3 MB         | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Arranca; `/health` y `/health/ready` 200         | Política: pasa · MEDIUM/LOW 7/4 · SBOM 354 → 136 componentes |
| `commerce-service-migrate` | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:ef3fbf698f96…` | 129.1 → 135.2 MB       | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Migraciones Prisma OK (Compose y emulación RDS)  | Política: pasa · MEDIUM/LOW 7/4 · SBOM 415 → 197 componentes |
| `audit-service-runtime`    | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:da160f36bcb5…` | 83.2 → 89.4 MB         | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Arranca; `/health` y `/health/ready` 200         | Política: pasa · MEDIUM/LOW 7/4 · SBOM 345 → 127 componentes |
| `audit-service-migrate`    | `node:22.14.0-alpine3.21@sha256:9bef0ef1…` → `node:22.23.5-alpine3.24@sha256:1314fb30…`                | `sha256:3177b74af05a…` | 124.0 → 130.2 MB       | 5 → **0** | 59 → **0** | npm, npx, corepack, yarn                            | Migraciones Prisma OK (Compose y emulación RDS)  | Política: pasa · MEDIUM/LOW 7/4 · SBOM 391 → 173 componentes |
| `db-ops`                   | `postgres:16.6-alpine@sha256:1d04b9ba…` → `alpine:3.24.4@sha256:f59abe65… + postgresql16-client 16.16` | `sha256:788f7a344b55…` | 109.5 → 9.3 MB         | 7 → **0** | 96 → **0** | servidor PostgreSQL, gosu, herramientas de servidor | Provision, finalize y rollback OK; DT-09 492/492 | Política: pasa · MEDIUM/LOW 7/4 · SBOM 52 → 25 componentes   |

Resumen: **0 CRITICAL y 0 HIGH** en las 9 imágenes (antes 615 bloqueantes, 124 únicos); 0 secretos; Alpine 3.24.4 con soporte. `db-ops` pasa de 109,5 MB a 9,3 MB. Las imágenes de servicio crecen unos 6 MB: la base nueva es algo mayor, y retirar npm, corepack y yarn no reduce el tamaño, porque los archivos quedan ocultos por una capa superior aunque sigan en la capa de la base (no son accesibles en el contenedor).

Validaciones (evidencia `EV-AWS-PR61-BASE-IMAGES-LOCAL-20261121` en la bóveda):

| Validación                                                                                                                             | Resultado                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Política de vulnerabilidades (`scan-images.sh`)                                                                                        | **0 bloqueos, 0 excepciones**; runtime sin `devDependencies` en `/app`                                                                                                                                                                                                                |
| npm, npx, corepack y yarn en `runtime` y `migrate`                                                                                     | Ausentes en las 8 imágenes; `node` v22.23.5; Prisma CLI solo en `migrate`; usuario `node`                                                                                                                                                                                             |
| `db-ops`                                                                                                                               | `psql` 16.16 (libpq 18.7); usuario `postgres` (70:70); sin servidor ni `gosu`; CA del sistema presente; scripts de solo lectura                                                                                                                                                       |
| Integración en un proyecto Compose desechable con **las imágenes analizadas** (cargadas desde los archivos OCI; ID = digest analizado) | provision (db-ops) → 4 migraciones → finalize OK; DT-09 **492/492**; suites de identity, catalog, audit y commerce aprobadas (cobertura de Commerce 88,39 / 77,18 / 96,51 / 92,76 %; RNF-REN-02 aprobada); los 4 servicios con `/health` y `/health/ready` 200; 0 errores en los logs |
| `db-ops`: rollback, reaprovisionamiento y DT-09                                                                                        | Rollback DT-09 OK (solo queda el propietario de la base); reaprovisionamiento idempotente; DT-09 492/492                                                                                                                                                                              |
| Emulación RDS (maestro no superusuario)                                                                                                | provision y finalize como `rds_master` OK; DT-09 **492/492**                                                                                                                                                                                                                          |
| TLS (PostgreSQL 16 desechable que solo admite TLS)                                                                                     | `psql` `sslmode=require` y `verify-full` con la CA correcta: TLSv1.3. Con otra CA, otro nombre de host, el almacén del sistema o `sslmode=disable`: rechazado. Prisma `migrate deploy` por TLS: OK (con `sslmode=require` cifra sin verificar el certificado, coherente con C6)       |
| Integridad (`release_tool.py verify-release`)                                                                                          | 9 imágenes íntegras, del commit analizado, con la política aprobada: los digest no cambiaron después del análisis                                                                                                                                                                     |
| `static-checks.sh`, Prettier y ESLint                                                                                                  | OK                                                                                                                                                                                                                                                                                    |

CI del PR #19 sobre `e5bba8c` (mismos Dockerfiles que `e5d87be`): 5/5 checks verdes (runs `44980190035` e `44980190077`).

Riesgos residuales:

- **npm en capas:** retirar npm, corepack y yarn los oculta en el contenedor (Trivy analiza el sistema de archivos final), pero sus archivos siguen en la capa de la imagen base. Eliminarlos de verdad exigiría una base sin npm (por ejemplo, distroless): es otra decisión.
- **Versión de PostgreSQL:** `postgresql16-client` fija la versión mayor (16), no la exacta. Se aparta a propósito del pin exacto propuesto en §5.3: Alpine 3.24 publica una sola versión de cada paquete (hoy 16.16-r0) y retira la anterior al actualizarla, así que un pin exacto rompería el build con la siguiente. El contenido publicado queda fijado por el digest de la imagen y registrado en el SBOM. El cliente usa `libpq` 18.7 (de `postgresql18`), compatible con servidores 16; la comprobación contra RDS 16 sigue en P7.
- **TLS de Prisma:** con `sslmode=require`, Prisma cifra pero **no verifica el certificado** (comprobado). Es la desviación C6 ya aceptada (ADR-AWS-05); `verify-full` con la CA de RDS queda como mejora.

Pendiente:

- El workflow `ecr-publish` con `publish = false` sobre `main` después del merge de PR-6.1. La línea base sobre `main` = `1947788` (run `44957535259`) confirmó en GitHub los 615 bloqueos y que `verify` funciona.
