export interface HealthResponse {
  readonly service: string;
  readonly status: 'ok';
}

export type ProductAvailability = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'AVAILABLE';

export interface CategorySummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface ProductSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: CategorySummary;
  readonly price: string;
  readonly currency: 'GTQ';
  readonly availability: ProductAvailability;
  readonly imageKey: string;
}

export interface ProductDetail extends ProductSummary {
  readonly sku: string;
}

export interface ProductPage {
  readonly items: readonly ProductSummary[];
  readonly meta: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export interface ApiErrorResponse {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly timestamp: string;
}

export type UserRole = 'CLIENTE' | 'ADMIN';

export interface AuthUser {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

export interface LoginResponse {
  readonly user: AuthUser;
  readonly returnTo: string;
}
