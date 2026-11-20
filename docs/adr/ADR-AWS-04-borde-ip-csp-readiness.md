# ADR-AWS-04 — IP real tras proxies, límite en Audit, CSP de producción y readiness

- **Estado:** propuesta (pendiente de aprobación del propietario). Implementada en la rama local `feature/aws-pr4-edge-hardening`.
- **Fecha:** 2026-11-20
- **Hallazgos:** AWS-11, AWS-15, AWS-16 y AWS-20 del [diagnóstico AWS](../operacion-y-aws/03-diagnostico-aws.md).

## Decisiones

1. **D-AWS-04-01. `TRUST_PROXY` (AWS-11).** El listener público de cada servicio aplica `app.set('trust proxy', …)`:
   - sin definir o `false`: no confía en ningún proxy (valor local, igual que antes);
   - de 1 a 10 saltos;
   - una lista de IP/CIDR.

   `true` se rechaza al arrancar, porque permitiría falsificar la IP con `X-Forwarded-For`. Los listeners internos no cambian. En el laboratorio (CloudFront → VPC origin → ALB) se recomienda la CIDR de la VPC (`TRUST_PROXY=10.20.0.0/16`), más robusta que contar saltos: confía en el ALB y en el origen VPC de CloudFront, y toma como cliente la primera dirección no confiable empezando por la derecha de la cadena (la del visitante, que añade CloudFront). Los valores que anteponga un cliente quedan a la izquierda y se ignoran. **Pendiente de verificar en AWS:** la cadena real de `X-Forwarded-For` (prueba P10).

2. **D-AWS-04-02. Límite por IP en Audit (AWS-15).** `ThrottlerGuard` global en el listener público (120/min, como el resto). La ingesta interna (3104) no lo usa.
3. **D-AWS-04-03. CSP de producción (AWS-16).** Un plugin de Vite (`apply: 'build'`) reescribe `connect-src` como `'self'` más los orígenes de `VITE_*_API_URL`, sin localhost ni `ws:`. `index.html` conserva la política de desarrollo, que necesita el HMR, y una URL vacía significa mismo origen. El build falla si una URL no es http(s) o si falta la directiva. En AWS se complementa con la _response headers policy_ de CloudFront (CSP, HSTS…).
4. **D-AWS-04-04. Readiness (AWS-20).** `GET /health/ready` ejecuta `SELECT 1` en la base del propio servicio con un límite de 2 s y responde 503 si falla, para que el ALB retire la tarea. No consulta otros servicios, para no propagar caídas en cascada. `GET /health` sigue siendo de vida (estático). Ambos quedan fuera del throttling (`@SkipThrottle`).

## Consecuencias

- Los target groups del ALB deben usar `/health/ready`. CloudFront no enruta `/health*`.
- El throttler sigue en memoria por réplica: con N réplicas el límite efectivo es N×. Las reglas rate-based de WAF siguen siendo la protección principal en el borde.
- La Web compilada sin `VITE_*` (contenedor local) ya no incluye `localhost:300x` ni `ws:` en `connect-src`. Hay que abrirla en <http://127.0.0.1:5173>, como ya indicaba la guía.
