# Contribuir

## Flujo de trabajo

1. Crear una rama `feat/*`, `fix/*`, `chore/*` o `docs/*` desde `main`.
2. Mantener el cambio pequeño y asociado a un requisito o control.
3. Ejecutar lint, tipos y pruebas antes de abrir el Pull Request.
4. Integrar únicamente mediante PR aprobado y checks en verde.

Los commits siguen Conventional Commits, por ejemplo `feat(catalog): add product listing` o `test(auth): reject role mass assignment`.

## Principios

- KISS: preferir la solución correcta más simple.
- No compartir entidades Prisma entre servicios.
- No confiar en precio, rol, propietario ni totales enviados por el cliente.
- No incluir secretos, datos reales ni resultados de seguridad inventados.
- Toda excepción de seguridad debe quedar justificada, aprobada y con vencimiento.
