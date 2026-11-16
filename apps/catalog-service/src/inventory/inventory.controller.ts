import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { StockReservation, StockReservationState } from '@spectra/contracts';
import type { Response } from 'express';
import { InventoryServiceGuard } from '../common/internal-service.guard.js';
import { CreateReservationDto, ReservationIdDto } from './inventory.dto.js';
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

  @Get(':reservationId')
  state(@Param() params: ReservationIdDto): Promise<StockReservationState> {
    return this.inventory.state(params.reservationId);
  }

  @Post(':reservationId/confirm')
  @HttpCode(200)
  confirm(@Param() params: ReservationIdDto): Promise<StockReservation> {
    return this.inventory.confirm(params.reservationId);
  }

  @Post(':reservationId/release')
  @HttpCode(200)
  release(@Param() params: ReservationIdDto): Promise<StockReservationState> {
    return this.inventory.release(params.reservationId);
  }
}
