# Operación local y preparación AWS

Documentación operativa de SPECTRA Shop sobre `main` = `2a27350` (MVP con M06/M07 mínimos), redactada el 2026-11-20. No modifica código, Dockerfiles, Compose ni `.env`, y no crea recursos AWS.

| Documento                                                | Para qué sirve                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [01-inventario-tecnico.md](01-inventario-tecnico.md)     | Estado verificado del repositorio: rutas reales, seguridad HTTP, datos, Compose, imágenes, CI y discrepancias detectadas       |
| [02-guia-operacion-local.md](02-guia-operacion-local.md) | Levantar, operar, respaldar, probar y diagnosticar el stack local paso a paso                                                  |
| [03-diagnostico-aws.md](03-diagnostico-aws.md)           | Hallazgos clasificados (bloqueante, necesario, recomendado, diferido) para desplegar en AWS                                    |
| [04-plan-despliegue-aws.md](04-plan-despliegue-aws.md)   | **Propuesta** de arquitectura y procedimiento de laboratorio (ECS Fargate, RDS, CloudFront), costos, destrucción y plan por PR |
| [05-publicacion-ecr.md](05-publicacion-ecr.md)           | Publicación manual de las 9 imágenes en ECR con OIDC (PR-6): Environment, protección de `main`, fallos seguros y excepciones   |
| [postman/](postman/README.md)                            | Colecciones Postman v2.1 (por servicio y flujo E2E), entornos y guía de ejecución                                              |

> [!WARNING]
> Las suites de integración (`*-test`) y el flujo E2E de Postman **escriben y borran datos**. Ejecútelos solo en un proyecto Compose desechable (`docker compose -p spectra-aislado …`), nunca en el stack principal `spectra-shop`. Ver la [guía, sección 18](02-guia-operacion-local.md#18-ejecutar-pruebas-de-forma-segura).

## Resumen de arquitectura

```text
Navegador ─▶ Web (React/Vite, 5173)
               ├─▶ identity-service  3001 │ 3101 interno  ─┐
               ├─▶ catalog-service   3002 │ 3102 interno  ─┤ (validate-touch → Identity)
               ├─▶ commerce-service  3003                 ─┤ (snapshot/reservas → Catalog)
               └─▶ audit-service     3004 │ 3104 interno  ◀┘ (relay outbox ← Catalog)
                         └──────────── PostgreSQL 16: esquemas identity · catalog · commerce · audit
                                       8 roles (migrador + ejecución por servicio, DT-09)
```

Autenticación: cookies `HttpOnly` con `SameSite=Strict` emitidas por Identity (JWT ES256 de 15 min y refresh rotado de 8 h), CSRF de doble envío con `Origin` en lista blanca y RBAC CLIENTE/ADMIN validado en cada servicio contra la sesión activa.

## Estado de preparación AWS

**No listo** (actualizado el 2026-11-21: los bloqueantes de código se resolvieron con los PR #12–#15 (PR-1 a PR-4), fusionados en `main` el 2026-11-20 (`a0f8052`), sin validación en AWS; el Terraform del laboratorio está en el Draft PR #16 (PR-5), sin aplicar; ver el [diagnóstico, §6](03-diagnostico-aws.md#6-estado-de-las-correcciones-actualizado-el-2026-11-20)). La arquitectura es desplegable como laboratorio en ECS Fargate + RDS. El diagnóstico inicial encontró 4 bloqueantes que requerían PR, hoy resueltos en código (claves JWT por archivo, aprovisionamiento DT-09 incompatible con el maestro no superusuario de RDS, jobs de BD con bind mounts e imagen de Docker Hub, y la excepción de picomatch, que excluye AWS de forma expresa) y 5 bloqueantes de configuración. Esfuerzo estimado hasta un laboratorio desplegable: ≈ 12–19 días-persona. Detalle en [03-diagnostico-aws.md](03-diagnostico-aws.md) y [04-plan-despliegue-aws.md](04-plan-despliegue-aws.md).

## Validación de estos entregables

| Comprobación                                                         | Resultado                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Colecciones Postman frente al esquema oficial v2.1.0                 | Válidas                                                                                                                 |
| URL de las colecciones frente a los decoradores de los controladores | 24/24 rutas públicas; 0 inventadas                                                                                      |
| Scripts de prueba de Postman                                         | 189 sin errores de sintaxis; prueba en seco de 132 aserciones contra los ejemplos                                       |
| Comandos de la guía frente a `compose.yaml`                          | Nombres de servicios, perfiles, volumen y variables contrastados (`docker compose config --services/--volumes/--quiet`) |
| Secretos en los archivos                                             | Ninguno (búsqueda de PEM, tokens hexadecimales y contraseñas)                                                           |
| Código funcional modificado                                          | Ninguno                                                                                                                 |
| **Ejecución contra un stack en marcha**                              | **Pendiente**: Docker estaba detenido y la tarea prohibía iniciar servicios                                             |
