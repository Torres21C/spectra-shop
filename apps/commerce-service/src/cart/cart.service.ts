import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CatalogCartSnapshot, CartLine, ShoppingCart } from '@spectra/contracts';
import type { Cart, CartItem, Prisma } from '../generated/commerce-client/index.js';
import { CatalogClientService } from '../catalog/catalog-client.service.js';
import { evaluateLine, money, ZERO } from '../common/pricing.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AddCartItemDto, UpdateCartItemDto } from './cart.dto.js';

const MAX_LINES = 20;
const INFLIGHT_STATES = ['STARTED', 'RESERVED', 'CONFIRMED'] as const;

type CartWithItems = Cart & { items: CartItem[] };

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogClientService,
  ) {}

  async get(userId: string, requestId: string): Promise<ShoppingCart> {
    const cart = await this.ensureActiveCart(userId);
    return this.present(cart, requestId);
  }

  async add(userId: string, dto: AddCartItemDto, requestId: string): Promise<ShoppingCart> {
    const [product] = await this.catalog.snapshot([dto.productId], requestId);
    this.assertProduct(product, dto.quantity);
    const cart = await this.ensureActiveCart(userId);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockCart(transaction, cart.id);
      const existing = await transaction.cartItem.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId: dto.productId } },
      });
      const quantity = (existing?.quantity ?? 0) + dto.quantity;
      this.assertProduct(product, quantity);
      if (!existing) {
        const count = await transaction.cartItem.count({ where: { cartId: cart.id } });
        if (count >= MAX_LINES) {
          throw new ConflictException({
            code: 'CART_LINE_LIMIT',
            message: 'El carrito admite un máximo de 20 productos',
          });
        }
      }
      await transaction.cartItem.upsert({
        where: { cartId_productId: { cartId: cart.id, productId: dto.productId } },
        create: { cartId: cart.id, productId: dto.productId, quantity },
        update: { quantity },
      });
      await transaction.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
    });
    return this.present(await this.loadCart(cart.id), requestId);
  }

  async update(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
    requestId: string,
  ): Promise<ShoppingCart> {
    const item = await this.ownedItem(userId, itemId);
    const [product] = await this.catalog.snapshot([item.productId], requestId);
    this.assertProduct(product, dto.quantity);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockCart(transaction, item.cartId);
      const result = await transaction.cartItem.updateMany({
        where: {
          id: itemId,
          cartId: item.cartId,
          cart: { userId, status: 'ACTIVO' },
        },
        data: { quantity: dto.quantity },
      });
      if (result.count !== 1) this.notFound();
      await transaction.cart.update({
        where: { id: item.cartId },
        data: { updatedAt: new Date() },
      });
    });
    return this.present(await this.loadCart(item.cartId), requestId);
  }

  async remove(userId: string, itemId: string, requestId: string): Promise<ShoppingCart> {
    const item = await this.ownedItem(userId, itemId);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockCart(transaction, item.cartId);
      const result = await transaction.cartItem.deleteMany({
        where: { id: itemId, cartId: item.cartId, cart: { userId, status: 'ACTIVO' } },
      });
      if (result.count !== 1) this.notFound();
      await transaction.cart.update({
        where: { id: item.cartId },
        data: { updatedAt: new Date() },
      });
    });
    return this.present(await this.loadCart(item.cartId), requestId);
  }

  private async ensureActiveCart(userId: string): Promise<CartWithItems> {
    const found = await this.prisma.cart.findFirst({
      where: { userId, status: 'ACTIVO' },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (found) return found;
    try {
      return await this.prisma.cart.create({
        data: { userId },
        include: { items: true },
      });
    } catch (error: unknown) {
      if (this.isUniqueConflict(error)) {
        const raced = await this.prisma.cart.findFirst({
          where: { userId, status: 'ACTIVO' },
          include: { items: { orderBy: { createdAt: 'asc' } } },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private loadCart(id: string): Promise<CartWithItems> {
    return this.prisma.cart.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
  }

  private async ownedItem(userId: string, itemId: string): Promise<CartItem> {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cart: { userId, status: 'ACTIVO' } },
    });
    if (!item) this.notFound();
    return item;
  }

  private async present(cart: CartWithItems, requestId: string): Promise<ShoppingCart> {
    const snapshots = await this.catalog.snapshot(
      cart.items.map((item) => item.productId),
      requestId,
    );
    const byId = new Map(snapshots.map((product) => [product.id, product]));
    let total = ZERO;
    const items: CartLine[] = cart.items.map((item) => {
      const product = byId.get(item.productId);
      const { unitPrice: unit, subtotal, reason } = evaluateLine(product, item.quantity);
      if (!reason) total = total.add(subtotal);
      return {
        id: item.id,
        productId: item.productId,
        name: product?.name ?? 'Producto no disponible',
        quantity: item.quantity,
        unitPrice: unit.toFixed(2),
        subtotal: subtotal.toFixed(2),
        available: reason === undefined,
        ...(reason ? { unavailableReason: reason } : {}),
      };
    });
    return {
      id: cart.id,
      status: cart.status,
      items,
      itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
      distinctItems: cart.items.length,
      total: money(total).toFixed(2),
      currency: 'GTQ',
      checkoutAllowed: items.length > 0 && items.every((item) => item.available),
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  private assertProduct(product: CatalogCartSnapshot | undefined, quantity: number): void {
    if (!product?.isActive || product.stock === 0) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_AVAILABLE',
        message: 'Producto no disponible',
      });
    }
    if (quantity > product.stock) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: `Cantidad máxima disponible: ${Math.min(product.stock, 10)}`,
      });
    }
  }

  /**
   * Bloquea la fila del carrito y rechaza mutaciones mientras un checkout está en curso (M04):
   * las líneas del pedido se toman del intento, por lo que el carrito queda congelado.
   */
  private async lockCart(transaction: Prisma.TransactionClient, cartId: string): Promise<void> {
    await transaction.$executeRaw`SELECT 1 FROM "commerce"."carts" WHERE "id" = ${cartId}::uuid FOR UPDATE`;
    const inflight = await transaction.checkoutAttempt.count({
      where: { cartId, state: { in: [...INFLIGHT_STATES] } },
    });
    if (inflight > 0) {
      throw new ConflictException({
        code: 'CART_LOCKED_FOR_CHECKOUT',
        message: 'El carrito tiene un checkout en curso',
      });
    }
  }

  private isUniqueConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'P2002';
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'CART_ITEM_NOT_FOUND',
      message: 'Línea de carrito no disponible',
    });
  }
}
