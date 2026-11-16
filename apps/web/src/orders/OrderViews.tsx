import type {
  AuthUser,
  OrderDetail,
  OrderHistoryPage,
  OrderStatus,
  OrderTimelineEntry,
} from '@spectra/contracts';
import { formatPrice } from '../catalog/ProductCard.js';

/** Todo el contenido se representa como texto: React lo escapa (RS04); no se usa HTML crudo. */

const STATUS_LABELS: Record<OrderStatus, string> = {
  PAGADO: 'Pagado',
  EN_PREPARACION: 'En preparación',
  ENVIADO: 'Enviado',
  ENTREGADO: 'Entregado',
  CANCELADO: 'Cancelado',
};

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('es-GT', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Guatemala',
  }).format(new Date(value));
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`order-badge order-badge-${status.toLowerCase()}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ProfileCard({ user }: { user: AuthUser }) {
  return (
    <section className="profile-card" aria-labelledby="profile-title">
      <p className="eyebrow">Perfil propio</p>
      <h1 id="profile-title">{user.fullName}</h1>
      <dl className="profile-list">
        <div>
          <dt>Correo</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Rol</dt>
          <dd>{user.role}</dd>
        </div>
        <div>
          <dt>Registro</dt>
          <dd>{new Date(user.createdAt).toLocaleDateString('es-GT')}</dd>
        </div>
      </dl>
    </section>
  );
}

/** RF-026: número, fecha, cantidad de artículos, total y estado, del más reciente al más antiguo. */
export function OrderHistoryView({ history }: { history: OrderHistoryPage }) {
  const { items, meta } = history;
  if (meta.totalItems === 0) {
    return (
      <div className="state-card">
        <h3>Aún no tienes pedidos</h3>
        <p>Cuando confirmes una compra aparecerá aquí.</p>
        <a className="primary-link" href="#/">
          Ver catálogo
        </a>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="state-card">
        <h3>Esta página no tiene pedidos</h3>
        <a className="primary-link" href="#/pedidos">
          Volver a la primera página
        </a>
      </div>
    );
  }
  return (
    <>
      <ul className="order-list">
        {items.map((order) => (
          <li key={order.id}>
            <a className="order-row" href={`#/pedidos/${order.id}`}>
              <span className="order-row-main">
                <strong>{order.orderNumber}</strong>
                <small>{formatDateTime(order.createdAt)}</small>
              </span>
              <span>
                {order.itemCount} {order.itemCount === 1 ? 'artículo' : 'artículos'}
              </span>
              <strong>{formatPrice(order.total)}</strong>
              <OrderStatusBadge status={order.status} />
            </a>
          </li>
        ))}
      </ul>
      {meta.totalPages > 1 && (
        <nav className="pagination" aria-label="Paginación del historial">
          {meta.page > 1 ? (
            <a className="pagination-link" href={`#/pedidos?page=${meta.page - 1}`}>
              Anterior
            </a>
          ) : (
            <span className="pagination-link" aria-disabled="true">
              Anterior
            </span>
          )}
          <span>
            Página {meta.page} de {meta.totalPages}
          </span>
          {meta.page < meta.totalPages ? (
            <a className="pagination-link" href={`#/pedidos?page=${meta.page + 1}`}>
              Siguiente
            </a>
          ) : (
            <span className="pagination-link" aria-disabled="true">
              Siguiente
            </span>
          )}
        </nav>
      )}
    </>
  );
}

/** RF-028: línea de tiempo con la fecha registrada de cada estado. */
export function OrderTimeline({ timeline }: { timeline: readonly OrderTimelineEntry[] }) {
  return (
    <ol className="order-timeline" aria-label="Línea de tiempo del pedido">
      {timeline.map((entry, index) => (
        <li key={entry.status} aria-current={index === timeline.length - 1 ? 'step' : undefined}>
          <OrderStatusBadge status={entry.status} />
          <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
        </li>
      ))}
    </ol>
  );
}

/** RF-027: líneas con precio congelado, datos de entrega ficticios, total y estado vigente. */
export function OrderDetailView({ order }: { order: OrderDetail }) {
  return (
    <section className="cart-shell">
      <a className="back-link" href="#/pedidos">
        ← Mis pedidos
      </a>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pedido · {formatDateTime(order.createdAt)}</p>
          <h1>{order.orderNumber}</h1>
        </div>
        <div className="order-current-status">
          <OrderStatusBadge status={order.status} />
          <small>
            desde{' '}
            <time dateTime={order.statusChangedAt}>{formatDateTime(order.statusChangedAt)}</time>
          </small>
        </div>
      </div>
      <div className="cart-layout">
        <div className="cart-lines">
          {order.items.map((item) => (
            <article className="cart-line confirmation-line" key={item.productId}>
              <div>
                <h2>{item.name}</h2>
                <p>
                  {item.quantity} × {formatPrice(item.unitPrice)} (precio de la compra)
                </p>
              </div>
              <strong>{formatPrice(item.lineTotal)}</strong>
            </article>
          ))}
          <article className="cart-line confirmation-line">
            <div>
              <h2>Entrega ficticia</h2>
              <p>
                {order.shipping.recipientName} · {order.shipping.phone}
                <br />
                {order.shipping.address}, {order.shipping.municipality}, {order.shipping.department}
                {order.shipping.references ? ` · ${order.shipping.references}` : ''}
              </p>
            </div>
          </article>
          <article className="cart-line timeline-card">
            <div>
              <h2>Seguimiento</h2>
              <OrderTimeline timeline={order.timeline} />
            </div>
          </article>
        </div>
        <aside className="cart-summary">
          <p>Total pagado (simulado)</p>
          <strong>{formatPrice(order.total)}</strong>
          <small>
            {order.itemCount} {order.itemCount === 1 ? 'artículo' : 'artículos'} · Referencia{' '}
            {order.paymentReference}
          </small>
          <small>Los pedidos no pueden modificarse ni cancelarse desde la tienda.</small>
        </aside>
      </div>
    </section>
  );
}
