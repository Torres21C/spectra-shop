import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { UnfulfilledReservationsReport } from '@spectra/contracts';
import { inventoryConfig } from './inventory.config.js';
import { InventoryService } from './inventory.service.js';

/**
 * DT-08: monitor del lado de Catalog. Al arrancar y periódicamente publica una métrica estructurada
 * (`stock_reservation_unfulfilled`) con las reservas CONFIRMED que superan el umbral sin
 * reconocimiento de Commerce: detecta el caso de Commerce no recuperable (R27). No libera ni
 * compensa stock: la resolución es manual.
 */
@Injectable()
export class InventoryDeliveryMonitorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InventoryDeliveryMonitorService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly inventory: InventoryService) {}

  onApplicationBootstrap(): void {
    void this.runOnce();
    if (inventoryConfig.deliveryMonitorIntervalMs > 0) {
      this.timer = setInterval(
        () => void this.runOnce(),
        inventoryConfig.deliveryMonitorIntervalMs,
      );
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<UnfulfilledReservationsReport | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const report = await this.inventory.unfulfilledReport(
        inventoryConfig.unfulfilledAgeSeconds,
        20,
      );
      const metric = {
        event: 'stock_reservation_unfulfilled',
        thresholdSeconds: inventoryConfig.unfulfilledAgeSeconds,
        count: report.total,
        maxAgeSeconds: report.items[0]?.ageSeconds ?? 0,
        // Solo identificadores de reserva: sin líneas, precios, usuarios ni datos de entrega.
        reservationIds: report.items.map((item) => item.reservationId),
      };
      if (report.total > 0) this.logger.warn(metric);
      return report;
    } catch (error: unknown) {
      this.logger.error({
        event: 'stock_reservation_unfulfilled_monitor_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return undefined;
    } finally {
      this.running = false;
    }
  }
}
