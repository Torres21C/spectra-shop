import { ServiceUnavailableException } from '@nestjs/common';

const READINESS_TIMEOUT_MS = 2_000;

/**
 * AWS-20: comprobación de preparación para el health check del ALB. Solo consulta la base de datos
 * propia (nunca otros servicios, para no propagar caídas en cascada) y responde 503 si no contesta a
 * tiempo, de modo que el balanceador retire la tarea.
 */
export async function assertDatabaseReady(
  probe: () => Promise<unknown>,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
      }),
    ]);
  } catch {
    throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Servicio no disponible' });
  } finally {
    clearTimeout(timer);
  }
}
