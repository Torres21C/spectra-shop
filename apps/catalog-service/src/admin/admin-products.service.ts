import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { Prisma } from '@prisma/client';
import { normalizeSearchText } from '../catalog/catalog.helpers.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AdminProductCreated, CreateProductDto } from './admin-products.dto.js';

export interface AdminActor extends ValidatedSession {
  readonly requestId: string;
  readonly sourceIp?: string | undefined;
}

/** Clave de imagen del catálogo predefinido (sin carga de archivos); M06 mínimo usa la genérica. */
const DEFAULT_IMAGE_KEY = 'generic';

@Injectable()
export class AdminProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea el producto y su evento PRODUCT_CREATED en la misma transacción: si la outbox falla, el
   * producto no se crea (fail-closed para acciones administrativas).
   */
  async create(dto: CreateProductDto, actor: AdminActor): Promise<AdminProductCreated> {
    const price = Number(dto.price);
    if (!(price >= 0.01 && price <= 99_999.99)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Precio inválido' });
    }
    const description = dto.description ?? '';
    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.category.findUnique({ where: { id: dto.categoryId } });
        if (!category) {
          throw new BadRequestException({
            code: 'INVALID_CATEGORY',
            message: 'La categoría no existe',
          });
        }
        const product = await tx.product.create({
          data: {
            sku: dto.sku,
            name: dto.name,
            description,
            searchText: normalizeSearchText(`${dto.name} ${description}`),
            price: dto.price,
            stock: dto.stock,
            imageKey: DEFAULT_IMAGE_KEY,
            categoryId: category.id,
          },
        });
        await tx.outboxEvent.create({
          data: {
            eventType: 'PRODUCT_CREATED',
            result: 'EXITO',
            actorId: actor.userId,
            actorRole: actor.role,
            resourceType: 'product',
            resourceId: product.id,
            sourceIp: actor.sourceIp?.slice(0, 64) ?? null,
            requestId: actor.requestId,
            // Lista blanca (RN-30): valores nuevos del producto; nunca tokens, cookies ni cabeceras.
            metadata: {
              sku: product.sku,
              name: product.name,
              price: product.price.toFixed(2),
              stock: product.stock,
              categoryId: category.id,
              isActive: product.isActive,
            },
          },
        });
        return {
          id: product.id,
          sku: product.sku,
          name: product.name,
          price: product.price.toFixed(2),
          stock: product.stock,
          isActive: product.isActive,
          category: { id: category.id, slug: category.slug, name: category.name },
        };
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'SKU_DUPLICATED', message: 'El SKU ya existe' });
      }
      throw error;
    }
  }
}
