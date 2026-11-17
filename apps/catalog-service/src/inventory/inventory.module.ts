import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryServiceGuard } from '../common/internal-service.guard.js';
import { InventoryDeliveryMonitorService } from './inventory-delivery-monitor.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { ReservationSweeperService } from './reservation-sweeper.service.js';

/** Importado solo por el listener interno: el barrido y el monitor DT-08 corren una vez por proceso. */
@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    ReservationSweeperService,
    InventoryDeliveryMonitorService,
    InventoryServiceGuard,
  ],
  exports: [InventoryService, ReservationSweeperService, InventoryDeliveryMonitorService],
})
export class InventoryModule {}
