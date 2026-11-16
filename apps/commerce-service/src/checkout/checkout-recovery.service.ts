import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { commerceConfig } from '../config/commerce.config.js';
import { CheckoutService, type ReconcileResult, type SagaMetrics } from './checkout.service.js';

export interface RecoveryRunReport {
  readonly outcomes: Record<ReconcileResult, number>;
  readonly newlyStuck: readonly string[];
  readonly metrics: SagaMetrics | undefined;
}

/**
 * Reconciliador de sagas pendientes (D-M04-06, reforzado en M04.1). Se ejecuta al arrancar Commerce
 * —recuperación tras reinicio— y periódicamente. Solo toma intentos con arrendamiento vencido y cuyo
 * backoff terminó, así que puede correr en varias réplicas sin duplicar efectos. Cada ciclo detecta
 * sagas atascadas y publica métricas estructuradas (`checkout_saga_metrics`).
 */
@Injectable()
export class CheckoutRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CheckoutRecoveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Contadores acumulados del proceso (complementan las métricas calculadas desde la BD). */
  private readonly totals: Record<ReconcileResult, number> = {
    SKIPPED: 0,
    COMPLETED: 0,
    ABORTED: 0,
    DEFERRED: 0,
  };

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

  async runOnce(): Promise<RecoveryRunReport> {
    const outcomes: Record<ReconcileResult, number> = {
      SKIPPED: 0,
      COMPLETED: 0,
      ABORTED: 0,
      DEFERRED: 0,
    };
    if (this.running) return { outcomes, newlyStuck: [], metrics: undefined };
    this.running = true;
    try {
      const ids = await this.checkout.staleAttempts(commerceConfig.recoveryBatchSize);
      for (const id of ids) {
        const result = await this.checkout.reconcile(id, randomUUID());
        outcomes[result] += 1;
        this.totals[result] += 1;
      }
      const newlyStuck = await this.checkout.detectStuck();
      const metrics = await this.checkout.sagaMetrics();
      const report = {
        event: 'checkout_saga_metrics',
        ...metrics,
        run: outcomes,
        totals: this.totals,
      };
      if (metrics.stuck > 0) this.logger.error(report);
      else if (metrics.inflightTotal > 0 || ids.length > 0) this.logger.log(report);
      return { outcomes, newlyStuck, metrics };
    } catch (error: unknown) {
      this.logger.error({
        event: 'checkout_recovery_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return { outcomes, newlyStuck: [], metrics: undefined };
    } finally {
      this.running = false;
    }
  }
}
