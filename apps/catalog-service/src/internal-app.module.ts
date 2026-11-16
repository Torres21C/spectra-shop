import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { InternalCatalogController } from './catalog/internal-catalog.controller.js';
import { InternalServiceGuard } from './common/internal-service.guard.js';
import { InventoryModule } from './inventory/inventory.module.js';

@Module({
  imports: [CatalogModule, InventoryModule],
  controllers: [InternalCatalogController],
  providers: [InternalServiceGuard],
})
export class InternalAppModule {}
