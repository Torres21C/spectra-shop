import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  CategorySummary,
  ProductDetail,
  ProductPage,
  ProductSummary,
} from '@spectra/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { availabilityForStock, normalizeSearchText } from './catalog.helpers.js';
import type { CatalogQueryDto } from './catalog-query.dto.js';

const PAGE_SIZE = 12;

type ProductWithCategory = Prisma.ProductGetPayload<{ include: { category: true } }>;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(): Promise<CategorySummary[]> {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true },
    });
  }

  async listProducts(query: CatalogQueryDto): Promise<ProductPage> {
    if (query.category) {
      const categoryExists = await this.prisma.category.findFirst({
        where: { slug: query.category, isActive: true },
        select: { id: true },
      });
      if (!categoryExists) {
        throw new BadRequestException({
          code: 'INVALID_CATEGORY',
          message: 'Parámetros inválidos',
        });
      }
    }

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      category: { isActive: true, ...(query.category ? { slug: query.category } : {}) },
      ...(query.search
        ? { searchText: { contains: normalizeSearchText(query.search), mode: 'insensitive' } }
        : {}),
    };

    const [products, totalItems] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: { category: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: products.map((product) => this.toSummary(product)),
      meta: {
        page: query.page,
        pageSize: PAGE_SIZE,
        totalItems,
        totalPages: Math.ceil(totalItems / PAGE_SIZE),
      },
    };
  }

  async getProduct(id: string): Promise<ProductDetail> {
    const product = await this.prisma.product.findFirst({
      where: { id, isActive: true, category: { isActive: true } },
      include: { category: true },
    });

    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_AVAILABLE',
        message: 'Producto no disponible',
      });
    }

    return { ...this.toSummary(product), sku: product.sku };
  }

  private toSummary(product: ProductWithCategory): ProductSummary {
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      category: {
        id: product.category.id,
        slug: product.category.slug,
        name: product.category.name,
      },
      price: product.price.toFixed(2),
      currency: 'GTQ',
      availability: availabilityForStock(product.stock),
      imageKey: product.imageKey,
    };
  }
}
