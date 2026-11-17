import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type {
  StockReservation,
  StockReservationFulfillment,
  StockReservationState,
  UnfulfilledReservationsReport,
} from '@spectra/contracts';
import type { Response } from 'express';
import { InventoryServiceGuard } from '../common/internal-service.guard.js';
import { inventoryConfig } from './inventory.config.js';
import {
  CreateReservationDto,
  FulfillReservationDto,
  ReservationIdDto,
  UnfulfilledQueryDto,
} from './inventory.dto.js';
import { InventoryService } from './inventory.service.js';

/** API interna de inventario M04. Solo existe en el listener interno y exige el token de inventario. */
@ApiExcludeController()
@Controller('internal/catalog/stock-reservations')
@UseGuards(InventoryServiceGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post()
  async reserve(
    @Body() dto: CreateReservationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockReservation> {
    const result = await this.inventory.reserve(dto);
    response.status(result.created ? 201 : 200);
    return result.reservation;
  }

  /** DT-08: declarada antes de `:reservationId` para que la ruta estática tenga prioridad. */
  @Get('unfulfilled')
  unfulfilled(@Query() query: UnfulfilledQueryDto): Promise<UnfulfilledReservationsReport> {
    return this.inventory.unfulfilledReport(
      query.olderThanSeconds ?? inventoryConfig.unfulfilledAgeSeconds,
      query.limit ?? 100,
    );
  }

  @Get(':reservationId')
  state(@Param() params: ReservationIdDto): Promise<StockReservationState> {
    return this.inventory.state(params.reservationId);
  }

  @Post(':reservationId/confirm')
  @HttpCode(200)
  confirm(@Param() params: ReservationIdDto): Promise<StockReservation> {
    return this.inventory.confirm(params.reservationId);
  }

  /** DT-08: reconocimiento de entrega idempotente (201 la primera vez, 200 en repeticiones). */
  @Post(':reservationId/fulfill')
  async fulfill(
    @Param() params: ReservationIdDto,
    @Body() dto: FulfillReservationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockReservationFulfillment> {
    const result = await this.inventory.fulfill(params.reservationId, dto.orderId);
    response.status(result.created ? 201 : 200);
    return result.fulfillment;
  }

  @Post(':reservationId/release')
  @HttpCode(200)
  release(@Param() params: ReservationIdDto): Promise<StockReservationState> {
    return this.inventory.release(params.reservationId);
  }
}
