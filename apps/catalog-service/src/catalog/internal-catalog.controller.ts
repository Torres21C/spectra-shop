import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { CatalogCartSnapshotResponse } from '@spectra/contracts';
import { InternalServiceGuard } from '../common/internal-service.guard.js';
import { CatalogService } from './catalog.service.js';
import { CartSnapshotRequestDto } from './internal-catalog.dto.js';

@ApiExcludeController()
@Controller('internal/catalog')
@UseGuards(InternalServiceGuard)
export class InternalCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Post('cart-snapshot')
  cartSnapshot(@Body() dto: CartSnapshotRequestDto): Promise<CatalogCartSnapshotResponse> {
    return this.catalog.cartSnapshot(dto.productIds);
  }
}
