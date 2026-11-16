import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ShoppingCart } from '@spectra/contracts';
import { CartAccessGuard } from '../auth/cart-access.guard.js';
import { CsrfService } from '../auth/csrf.service.js';
import type { CommerceRequest } from '../common/request-context.js';
import { AddCartItemDto, CartItemIdDto, UpdateCartItemDto } from './cart.dto.js';
import { CartService } from './cart.service.js';

@ApiTags('Carrito')
@ApiCookieAuth('access-cookie')
@UseGuards(CartAccessGuard)
@Controller('cart')
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly csrf: CsrfService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtiene y revalida el carrito del cliente autenticado' })
  @ApiOkResponse({ description: 'Carrito con importes calculados en el servidor' })
  @ApiUnauthorizedResponse({ description: 'Sesión ausente, inválida, revocada o expirada' })
  @ApiForbiddenResponse({ description: 'El rol ADMIN no puede comprar' })
  @ApiServiceUnavailableResponse({ description: 'Identity o Catalog no disponible' })
  get(@Req() request: CommerceRequest): Promise<ShoppingCart> {
    return this.cart.get(request.auth!.userId, request.requestId);
  }

  @Post('items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Agrega o incrementa una línea del carrito' })
  @ApiOkResponse({ description: 'Carrito recalculado' })
  @ApiBadRequestResponse({ description: 'DTO inválido o campo no declarado' })
  @ApiConflictResponse({ description: 'Stock o límite de líneas excedido' })
  @ApiNotFoundResponse({ description: 'Producto no disponible' })
  add(@Body() dto: AddCartItemDto, @Req() request: CommerceRequest): Promise<ShoppingCart> {
    this.csrf.assert(request);
    return this.cart.add(request.auth!.userId, dto, request.requestId);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Reemplaza la cantidad de una línea propia' })
  @ApiOkResponse({ description: 'Carrito recalculado' })
  update(
    @Param() params: CartItemIdDto,
    @Body() dto: UpdateCartItemDto,
    @Req() request: CommerceRequest,
  ): Promise<ShoppingCart> {
    this.csrf.assert(request);
    return this.cart.update(request.auth!.userId, params.itemId, dto, request.requestId);
  }

  @Delete('items/:itemId')
  @ApiOperation({ summary: 'Elimina una línea propia y recalcula el carrito' })
  @ApiOkResponse({ description: 'Carrito recalculado' })
  remove(@Param() params: CartItemIdDto, @Req() request: CommerceRequest): Promise<ShoppingCart> {
    this.csrf.assert(request);
    return this.cart.remove(request.auth!.userId, params.itemId, request.requestId);
  }
}
