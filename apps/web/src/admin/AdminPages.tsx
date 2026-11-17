import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { CategorySummary, OrderHistoryPage } from '@spectra/contracts';
import { useAuth } from '../auth/AuthContext.js';
import { getCategories } from '../catalog/catalog-api.js';
import { formatPrice } from '../catalog/ProductCard.js';
import { getAdminOrders } from '../orders/orders-api.js';
import {
  AdminApiError,
  type AuditEventItem,
  type CreatedProduct,
  createProduct,
  getAuditEvents,
} from './admin-api.js';

const SKU = /^[A-Z0-9-]{4,20}$/;
const PRICE = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/;

/** Solo mejora la experiencia: la autorización real la aplica cada servicio (RBAC ADMIN). */
function AdminGate({ returnTo, children }: { returnTo: string; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <span className="spinner" />
          Cargando…
        </div>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <h1>Inicia sesión como administrador</h1>
          <a className="primary-link" href={`#/login?returnTo=${encodeURIComponent(returnTo)}`}>
            Ingresar
          </a>
        </div>
      </main>
    );
  }
  if (user.role !== 'ADMIN') {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>Acceso no permitido</h1>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}

export function validateProductForm(input: {
  sku: string;
  name: string;
  description: string;
  categoryId: string;
  price: string;
  stock: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!SKU.test(input.sku.trim())) errors.sku = 'Usa 4–20 caracteres: A-Z, 0-9 y guiones.';
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) errors.name = 'El nombre debe tener 3–100 caracteres.';
  if (input.description.trim().length > 1000) errors.description = 'Máximo 1000 caracteres.';
  if (!input.categoryId) errors.categoryId = 'Selecciona una categoría.';
  const price = Number(input.price);
  if (!PRICE.test(input.price.trim()) || !(price >= 0.01 && price <= 99_999.99)) {
    errors.price = 'Precio entre 0.01 y 99999.99 con hasta 2 decimales.';
  }
  const stock = Number(input.stock);
  if (!/^\d{1,4}$/.test(input.stock.trim()) || stock < 0 || stock > 9999) {
    errors.stock = 'Stock entero entre 0 y 9999.';
  }
  return errors;
}

function NewProductForm() {
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [created, setCreated] = useState<CreatedProduct>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getCategories(controller.signal)
      .then(setCategories)
      .catch(() => setMessage('No fue posible cargar las categorías.'));
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const input = {
      sku: text('sku'),
      name: text('name'),
      description: text('description'),
      categoryId: text('categoryId'),
      price: text('price'),
      stock: text('stock'),
    };
    const found = validateProductForm(input);
    setErrors(found);
    setMessage('');
    setCreated(undefined);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const product = await createProduct({
        sku: input.sku.trim(),
        name: input.name.trim(),
        description: input.description.trim(),
        categoryId: input.categoryId,
        price: input.price.trim(),
        stock: Number(input.stock),
      });
      setCreated(product);
      form.reset();
    } catch (error: unknown) {
      if (error instanceof AdminApiError && error.status === 409) setErrors({ sku: error.message });
      else setMessage(error instanceof Error ? error.message : 'No fue posible crear el producto');
    } finally {
      setBusy(false);
    }
  }

  const field = (name: string, label: string, input: ReactNode) => (
    <label className={errors[name] ? 'field-invalid' : undefined}>
      {label}
      {input}
      {errors[name] && <small role="alert">{errors[name]}</small>}
    </label>
  );

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="new-product-title">
        <p className="eyebrow">M06 · Administración</p>
        <h1 id="new-product-title">Nuevo producto</h1>
        <p>El producto se crea activo y queda registrado en la auditoría.</p>
        <form onSubmit={(event) => void submit(event)} className="auth-form" noValidate>
          {field('sku', 'SKU', <input name="sku" maxLength={20} autoComplete="off" required />)}
          {field(
            'name',
            'Nombre',
            <input name="name" maxLength={100} autoComplete="off" required />,
          )}
          {field(
            'categoryId',
            'Categoría',
            <select name="categoryId" defaultValue="" required>
              <option value="">Selecciona…</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>,
          )}
          {field(
            'price',
            'Precio (GTQ)',
            <input name="price" inputMode="decimal" placeholder="199.90" autoComplete="off" />,
          )}
          {field(
            'stock',
            'Stock inicial',
            <input name="stock" inputMode="numeric" placeholder="10" autoComplete="off" />,
          )}
          {field(
            'description',
            'Descripción (opcional)',
            <input name="description" maxLength={1000} autoComplete="off" />,
          )}
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          {created && (
            <p className="form-message" role="status">
              Producto {created.sku} creado: {created.name} · {formatPrice(created.price)} · stock{' '}
              {created.stock}.{' '}
              <a href={`#/producto/${encodeURIComponent(created.id)}`}>Ver en el catálogo</a>
            </p>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? 'Creando…' : 'Crear producto'}
          </button>
        </form>
      </section>
    </main>
  );
}

export function AdminProductPage() {
  return (
    <AdminGate returnTo="#/admin/productos/nuevo">
      <NewProductForm />
    </AdminGate>
  );
}

function OrdersTable({ page }: { page: number }) {
  const [data, setData] = useState<OrderHistoryPage>();
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError('');
    void getAdminOrders(page, controller.signal)
      .then(setData)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'No fue posible cargar los pedidos');
      });
    return () => controller.abort();
  }, [page]);

  if (error) {
    return (
      <div className="state-card error-state" role="alert">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="state-card">
        <span className="spinner" />
        Cargando pedidos…
      </div>
    );
  }
  return (
    <>
      <p>
        {data.meta.totalItems} pedidos · página {data.meta.page} de{' '}
        {Math.max(data.meta.totalPages, 1)}
      </p>
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Pedido</th>
            <th scope="col">Estado</th>
            <th scope="col">Unidades</th>
            <th scope="col">Total</th>
            <th scope="col">Fecha</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((order) => (
            <tr key={order.id}>
              <td>{order.orderNumber}</td>
              <td>{order.status}</td>
              <td>{order.itemCount}</td>
              <td>{formatPrice(order.total)}</td>
              <td>{new Date(order.createdAt).toLocaleString('es-GT')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <nav className="pagination" aria-label="Páginas de pedidos">
        {data.meta.page > 1 && <a href={`#/admin/pedidos?page=${data.meta.page - 1}`}>Anterior</a>}
        {data.meta.page < data.meta.totalPages && (
          <a href={`#/admin/pedidos?page=${data.meta.page + 1}`}>Siguiente</a>
        )}
      </nav>
    </>
  );
}

export function AdminOrdersPage({ page }: { page: number }) {
  return (
    <AdminGate returnTo="#/admin/pedidos">
      <main className="cart-page">
        <section className="cart-shell">
          <div className="section-heading">
            <div>
              <p className="eyebrow">M06 · Administración</p>
              <h1>Pedidos (solo lectura)</h1>
            </div>
          </div>
          <OrdersTable page={page} />
        </section>
      </main>
    </AdminGate>
  );
}

/** Metadatos como texto literal (React escapa): nunca se interpreta HTML de un evento. */
function formatMetadata(metadata: Readonly<Record<string, unknown>>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

export function AuditEventsTable({ events }: { events: readonly AuditEventItem[] }) {
  if (events.length === 0) return <p>Aún no hay eventos registrados.</p>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th scope="col">Fecha (UTC)</th>
          <th scope="col">Evento</th>
          <th scope="col">Resultado</th>
          <th scope="col">Actor</th>
          <th scope="col">Recurso</th>
          <th scope="col">Detalle</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td>{event.occurredAt.replace('T', ' ').replace('Z', '')}</td>
            <td>{event.eventType}</td>
            <td>{event.result}</td>
            <td>
              {event.actorRole ?? 'anónimo'}
              {event.actorId ? ` · ${event.actorId.slice(0, 8)}…` : ''}
            </td>
            <td>
              {event.resourceType}
              {event.resourceId ? ` · ${event.resourceId.slice(0, 8)}…` : ''}
            </td>
            <td>{formatMetadata(event.metadata)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditList() {
  const [events, setEvents] = useState<AuditEventItem[]>();
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void getAuditEvents(controller.signal)
      .then(setEvents)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'No fue posible cargar la auditoría');
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <>
      <button
        className="secondary-button"
        type="button"
        onClick={() => setReloadKey((value) => value + 1)}
      >
        Actualizar
      </button>
      {error && (
        <div className="state-card error-state" role="alert">
          {error}
        </div>
      )}
      {!error && !events && (
        <div className="state-card">
          <span className="spinner" />
          Cargando eventos…
        </div>
      )}
      {events && <AuditEventsTable events={events} />}
    </>
  );
}

export function AdminAuditPage() {
  return (
    <AdminGate returnTo="#/admin/auditoria">
      <main className="cart-page">
        <section className="cart-shell">
          <div className="section-heading">
            <div>
              <p className="eyebrow">M07 · Auditoría</p>
              <h1>Últimos eventos (solo lectura)</h1>
            </div>
          </div>
          <AuditList />
        </section>
      </main>
    </AdminGate>
  );
}
