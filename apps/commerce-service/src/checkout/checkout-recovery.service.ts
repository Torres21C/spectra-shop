import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { commerceConfig } from '../config/commerce.config.js';
import { CheckoutService, type ReconcileResult } from './checkout.service.js';

/**
 * Reconciliador de sagas pendientes (D-M04-06). Se ejecuta al arrancar Commerce —recuperación tras
 * reinicio— y periódicamente. Solo toma intentos con arrendamiento vencido, así que puede correr en
 * varias réplicas sin duplicar efectos.
 */
@Injectable()
export class CheckoutRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CheckoutRecoveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly checkout: CheckoutService) {}

  onApplicationBootstrap(): void {
    void this.runOnce();
    if (commerceConfig.recoveryIntervalMs > 0) {
      this.timer = setInterval(() => void this.runOnce(), commerceConfig.recoveryIntervalMs);
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<Record<ReconcileResult, number>> {
    const summary: Record<ReconcileResult, number> = {
      SKIPPED: 0,
      COMPLETED: 0,
      ABORTED: 0,
      DEFERRED: 0,
    };
    if (this.running) return summary;
    this.running = true;
    try {
      const ids = await this.checkout.staleAttempts(commerceConfig.recoveryBatchSize);
      for (const id of ids) {
        try {
          summary[await this.checkout.reconcile(id, randomUUID())] += 1;
        } catch (error: unknown) {
          summary.DEFERRED += 1;
          this.logger.error({
            event: 'checkout_recovery_failed',
            attemptId: id,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
      if (ids.length > 0) this.logger.log({ event: 'checkout_recovery_run', ...summary });
      return summary;
    } catch (error: unknown) {
      this.logger.error({
        event: 'checkout_recovery_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return summary;
    } finally {
      this.running = false;
    }
  }
}
