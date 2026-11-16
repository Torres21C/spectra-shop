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
  readonly details?: ApiErrorDetails;
}

export type CheckoutConflictReason = 'INACTIVE' | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED';

export interface CheckoutConflictLine {
  readonly productId: string;
  readonly reason: CheckoutConflictReason;
  /** Unidades que todavía pueden comprarse, acotadas a 10 como en M03. */
  readonly available: number;
}

export interface ApiErrorDetails {
  readonly conflicts?: readonly CheckoutConflictLine[];
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

export interface CatalogCartSnapshot {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly stock: number;
  readonly isActive: boolean;
}

export interface CatalogCartSnapshotResponse {
  readonly products: readonly CatalogCartSnapshot[];
}

export interface ValidatedSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: UserRole;
}

export type CartStatus = 'ACTIVO' | 'CONVERTIDO';

export interface CartLine {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly subtotal: string;
  readonly available: boolean;
  readonly unavailableReason?: 'INACTIVE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK';
}

export interface ShoppingCart {
  readonly id: string;
  readonly status: CartStatus;
  readonly items: readonly CartLine[];
  readonly itemCount: number;
  readonly distinctItems: number;
  readonly total: string;
  readonly currency: 'GTQ';
  readonly checkoutAllowed: boolean;
  readonly updatedAt: string;
}

export type StockReservationStatus = 'PENDING' | 'CONFIRMED' | 'RELEASED';

export interface StockReservationLineRequest {
  readonly productId: string;
  readonly quantity: number;
  readonly expectedUnitPrice: string;
}

export interface StockReservationRequest {
  readonly reservationId: string;
  readonly lines: readonly StockReservationLineRequest[];
}

export interface StockReservationLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
}

export interface StockReservation {
  readonly reservationId: string;
  readonly status: StockReservationStatus;
  readonly expiresAt: string;
  readonly lines: readonly StockReservationLine[];
}

export interface StockReservationState {
  readonly reservationId: string;
  readonly status: StockReservationStatus | 'NOT_FOUND';
  readonly expired: boolean;
  readonly lines: readonly StockReservationLine[];
}

export interface StockReservationConflict {
  readonly code: 'STOCK_CONFLICT';
  readonly conflicts: readonly CheckoutConflictLine[];
}

export type SimulatedPaymentResult = 'APROBADO' | 'RECHAZADO';

export type OrderStatus = 'PAGADO' | 'EN_PREPARACION' | 'ENVIADO' | 'ENTREGADO' | 'CANCELADO';

export interface CheckoutSummaryLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly subtotal: string;
  readonly available: boolean;
  readonly unavailableReason?: 'INACTIVE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK';
}

export interface CheckoutSummary {
  readonly cartId: string;
  readonly items: readonly CheckoutSummaryLine[];
  readonly itemCount: number;
  readonly total: string;
  readonly currency: 'GTQ';
  /** Huella SHA-256 del resumen calculado en servidor; no contiene importes manipulables. */
  readonly fingerprint: string;
  readonly checkoutAllowed: boolean;
  readonly checkoutInProgress: boolean;
}

export interface ShippingDetails {
  readonly recipientName: string;
  readonly phone: string;
  readonly department: string;
  readonly municipality: string;
  readonly address: string;
  readonly references?: string;
}

export interface PlaceOrderRequest extends ShippingDetails {
  readonly simulatedPaymentResult: SimulatedPaymentResult;
  readonly cartFingerprint: string;
}

export interface OrderLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

export interface OrderConfirmation {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly total: string;
  readonly currency: 'GTQ';
  readonly itemCount: number;
  readonly paymentReference: string;
  readonly createdAt: string;
  readonly items: readonly OrderLine[];
  readonly shipping: ShippingDetails;
}

/** M05: un hito de la línea de tiempo del pedido (D-M05-01: una columna de fecha por estado). */
export interface OrderTimelineEntry {
  readonly status: OrderStatus;
  readonly at: string;
}

/**
 * M05 detalle (RF-027, RF-028): amplía la confirmación de M04 sin romperla. `statusChangedAt` es la
 * fecha del estado vigente, es decir, del último cambio registrado (CA-M05-04).
 */
export interface OrderDetail extends OrderConfirmation {
  readonly statusChangedAt: string;
  readonly timeline: readonly OrderTimelineEntry[];
}

/** M05 historial (RF-026): sin datos de entrega ni referencia de pago (minimización). */
export interface OrderSummary {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly statusChangedAt: string;
  readonly createdAt: string;
  readonly itemCount: number;
  readonly total: string;
  readonly currency: 'GTQ';
}

/** Página del historial; el tamaño (10) lo fija el servidor (D-M05-04). */
export interface OrderHistoryPage {
  readonly items: readonly OrderSummary[];
  readonly meta: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

/** Lista cerrada de los 22 departamentos (ERS §2.4); cada servicio mantiene su copia en tiempo de ejecución. */
export type GuatemalaDepartment =
  | 'Alta Verapaz'
  | 'Baja Verapaz'
  | 'Chimaltenango'
  | 'Chiquimula'
  | 'El Progreso'
  | 'Escuintla'
  | 'Guatemala'
  | 'Huehuetenango'
  | 'Izabal'
  | 'Jalapa'
  | 'Jutiapa'
  | 'Petén'
  | 'Quetzaltenango'
  | 'Quiché'
  | 'Retalhuleu'
  | 'Sacatepéquez'
  | 'San Marcos'
  | 'Santa Rosa'
  | 'Sololá'
  | 'Suchitepéquez'
  | 'Totonicapán'
  | 'Zacapa';
