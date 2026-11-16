import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { commerceConfig } from '../config/commerce.config.js';
import {
  InventoryFulfillmentService,
  type FulfillmentMetrics,
  type FulfillmentOutcome,
} from './inventory-fulfillment.service.js';

export interface FulfillmentRunReport {
  readonly outcomes: Record<FulfillmentOutcome, number>;
  readonly newlyStuck: readonly string[];
  readonly metrics: FulfillmentMetrics | undefined;
}

/**
 * DT-08: reconciliador del reconocimiento de entrega. Se ejecuta al arrancar Commerce (recupera
 * pedidos creados antes de una caída o del despliegue) y periódicamente. Solo toma intentos sin
 * arrendamiento vigente y con el backoff cumplido, por lo que varias réplicas no duplican efectos.
 * Cada ciclo detecta reconocimientos atascados y publica `inventory_fulfillment_metrics`.
 */
@Injectable()
export class InventoryFulfillmentRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InventoryFulfillmentRecoveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly fulfillment: InventoryFulfillmentService) {}

  onApplicationBootstrap(): void {
    void this.runOnce();
    if (commerceConfig.fulfillmentIntervalMs > 0) {
      this.timer = setInterval(() => void this.runOnce(), commerceConfig.fulfillmentIntervalMs);
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<FulfillmentRunReport> {
    const outcomes: Record<FulfillmentOutcome, number> = {
      FULFILLED: 0,
      DEFERRED: 0,
      STUCK: 0,
      SKIPPED: 0,
    };
    if (this.running) return { outcomes, newlyStuck: [], metrics: undefined };
    this.running = true;
    try {
      const ids = await this.fulfillment.dueAttempts(commerceConfig.fulfillmentBatchSize);
      for (const id of ids) {
        const owner = await this.fulfillment.claim(id);
        if (!owner) {
          outcomes.SKIPPED += 1;
          continue;
        }
        outcomes[await this.fulfillment.fulfill(id, owner, randomUUID())] += 1;
      }
      const newlyStuck = await this.fulfillment.detectStuck();
      const metrics = await this.fulfillment.metrics();
      const report = { event: 'inventory_fulfillment_metrics', ...metrics, run: outcomes };
      if (metrics.stuck > 0) this.logger.error(report);
      else if (metrics.pending > 0 || ids.length > 0) this.logger.log(report);
      return { outcomes, newlyStuck, metrics };
    } catch (error: unknown) {
      this.logger.error({
        event: 'inventory_fulfillment_recovery_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return { outcomes, newlyStuck: [], metrics: undefined };
    } finally {
      this.running = false;
    }
  }
}
