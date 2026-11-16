import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryServiceGuard } from '../common/internal-service.guard.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { ReservationSweeperService } from './reservation-sweeper.service.js';

/** Importado solo por el listener interno: el barrido corre una vez por proceso. */
@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [InventoryService, ReservationSweeperService, InventoryServiceGuard],
  exports: [InventoryService, ReservationSweeperService],
})
export class InventoryModule {}
