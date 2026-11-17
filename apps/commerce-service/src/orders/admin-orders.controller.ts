import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { OrderHistoryPage } from '@spectra/contracts';
import { AdminAccessGuard } from '../auth/admin-access.guard.js';
import { OrderHistoryQueryDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

/** M06 mínimo (RF-034 reducido): listado de solo lectura de todos los pedidos, sin transiciones. */
@ApiTags('Administración')
@ApiCookieAuth('access-cookie')
@UseGuards(AdminAccessGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Pedidos de todos los clientes, del más reciente al más antiguo' })
  @ApiOkResponse({ description: 'Página de pedidos (tamaño fijo del servidor)' })
  @ApiBadRequestResponse({ description: 'Página inválida o parámetro no declarado' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida o expirada' })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  list(@Query() query: OrderHistoryQueryDto): Promise<OrderHistoryPage> {
    return this.orders.allOrders(query.page);
  }
}
