import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { inventoryConfig } from './inventory.config.js';
import { InventoryService } from './inventory.service.js';

/**
 * Recuperación de Catalog: al arrancar y periódicamente libera reservas PENDING vencidas
 * (por ejemplo, si Commerce cayó entre la reserva y la confirmación).
 */
@Injectable()
export class ReservationSweeperService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReservationSweeperService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly inventory: InventoryService) {}

  onApplicationBootstrap(): void {
    void this.runOnce();
    if (inventoryConfig.sweepIntervalMs > 0) {
      this.timer = setInterval(() => void this.runOnce(), inventoryConfig.sweepIntervalMs);
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const released = await this.inventory.sweepExpired();
      if (released > 0) this.logger.log({ event: 'stock_reservation_sweep', released });
      return released;
    } catch (error: unknown) {
      this.logger.error({
        event: 'stock_reservation_sweep_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return 0;
    } finally {
      this.running = false;
    }
  }
}
