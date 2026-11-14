import type {
  ApiErrorResponse,
  CategorySummary,
  ProductAvailability,
  ProductDetail,
  ProductPage,
  ProductSummary,
} from '@spectra/contracts';

const API_BASE_URL = (import.meta.env.VITE_CATALOG_API_URL ?? 'http://127.0.0.1:3002').replace(
  /\/$/,
  '',
);
const AVAILABILITY = new Set<ProductAvailability>(['OUT_OF_STOCK', 'LOW_STOCK', 'AVAILABLE']);

export class CatalogApiError extends Error {
  readonly requestId: string | undefined;

  constructor(message: string, requestId?: string) {
    super(message);
    this.name = 'CatalogApiError';
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string')
    throw new CatalogApiError('La respuesta del catálogo no es válida');
  return value;
}

function decodeCategory(value: unknown): CategorySummary {
  if (!isRecord(value)) throw new CatalogApiError('La respuesta del catálogo no es válida');
  return {
    id: requiredString(value, 'id'),
    slug: requiredString(value, 'slug'),
    name: requiredString(value, 'name'),
  };
}

function decodeProduct(value: unknown): ProductSummary {
  if (!isRecord(value)) throw new CatalogApiError('La respuesta del catálogo no es válida');
  const availability = requiredString(value, 'availability');
  const currency = requiredString(value, 'currency');
  if (!AVAILABILITY.has(availability as ProductAvailability) || currency !== 'GTQ') {
    throw new CatalogApiError('La respuesta del catálogo no es válida');
  }
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    description: requiredString(value, 'description'),
    category: decodeCategory(value.category),
    price: requiredString(value, 'price'),
    currency,
    availability: availability as ProductAvailability,
    imageKey: requiredString(value, 'imageKey'),
  };
}

function decodeError(value: unknown): ApiErrorResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { statusCode, code, message, requestId, timestamp } = value;
  if (
    typeof statusCode !== 'number' ||
    typeof code !== 'string' ||
    typeof message !== 'string' ||
    typeof requestId !== 'string' ||
    typeof timestamp !== 'string'
  ) {
    return undefined;
  }
  return { statusCode, code, message, requestId, timestamp };
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    ...(signal ? { signal } : {}),
  });
  const payload: unknown = JSON.parse(await response.text());
  if (!response.ok) {
    const error = decodeError(payload);
    throw new CatalogApiError(
      error?.message ?? 'No fue posible consultar el catálogo',
      error?.requestId,
    );
  }
  return payload;
}

export async function getCategories(signal?: AbortSignal): Promise<CategorySummary[]> {
  const payload = await requestJson('/categories', signal);
  if (!Array.isArray(payload)) throw new CatalogApiError('La respuesta del catálogo no es válida');
  return payload.map(decodeCategory);
}

export async function getProducts(
  filters: { search?: string; category?: string; page: number },
  signal?: AbortSignal,
): Promise<ProductPage> {
  const query = new URLSearchParams({ page: String(filters.page) });
  if (filters.search) query.set('search', filters.search);
  if (filters.category) query.set('category', filters.category);
  const payload = await requestJson(`/products?${query.toString()}`, signal);
  if (!isRecord(payload) || !Array.isArray(payload.items) || !isRecord(payload.meta)) {
    throw new CatalogApiError('La respuesta del catálogo no es válida');
  }
  const { page, pageSize, totalItems, totalPages } = payload.meta;
  if ([page, pageSize, totalItems, totalPages].some((value) => typeof value !== 'number')) {
    throw new CatalogApiError('La respuesta del catálogo no es válida');
  }
  return {
    items: payload.items.map(decodeProduct),
    meta: {
      page: page as number,
      pageSize: pageSize as number,
      totalItems: totalItems as number,
      totalPages: totalPages as number,
    },
  };
}

export async function getProduct(productId: string, signal?: AbortSignal): Promise<ProductDetail> {
  const payload = await requestJson(`/products/${encodeURIComponent(productId)}`, signal);
  const product = decodeProduct(payload);
  if (!isRecord(payload)) throw new CatalogApiError('La respuesta del catálogo no es válida');
  return { ...product, sku: requiredString(payload, 'sku') };
}
