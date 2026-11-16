import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type {
  CheckoutConflictLine,
  CheckoutSummary,
  PlaceOrderRequest,
  SimulatedPaymentResult,
} from '@spectra/contracts';
import { useAuth } from '../auth/AuthContext.js';
import { useCart } from '../cart/CartContext.js';
import { formatPrice } from '../catalog/ProductCard.js';
import { CheckoutApiError, getCheckoutSummary, placeOrder } from './checkout-api.js';
import {
  GUATEMALA_DEPARTMENTS,
  type ShippingErrors,
  type ShippingField,
  validateShipping,
} from './checkout-validation.js';

type Notice = { readonly kind: 'error' | 'info' | 'pending'; readonly text: string };

const EMPTY_FORM: Record<ShippingField, string> = {
  recipientName: '',
  phone: '',
  department: '',
  municipality: '',
  address: '',
  references: '',
};

const REASONS = {
  INACTIVE: 'ya no está disponible',
  INSUFFICIENT_STOCK: 'no tiene stock suficiente',
  PRICE_CHANGED: 'cambió de precio',
} as const;

/** Errores técnicos: la confirmación pudo quedar en curso y se reintenta con la MISMA clave. */
const PENDING_CODES = new Set([
  'CHECKOUT_PENDING',
  'CHECKOUT_IN_PROGRESS',
  'CHECKOUT_EXPIRED',
  'NETWORK_ERROR',
  'CATALOG_UNAVAILABLE',
  'IDENTITY_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
]);

function newKey(): string {
  return crypto.randomUUID();
}

export function CheckoutPage() {
  const { user, loading: authLoading } = useAuth();
  const { reload: reloadCart } = useCart();
  const [summary, setSummary] = useState<CheckoutSummary>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<ShippingErrors>({});
  const [payment, setPayment] = useState<SimulatedPaymentResult>('APROBADO');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [conflicts, setConflicts] = useState<readonly CheckoutConflictLine[]>([]);
  const keyRef = useRef(newKey());
  const lastRequest = useRef<PlaceOrderRequest | undefined>(undefined);

  async function loadSummary(signal?: AbortSignal): Promise<void> {
    setLoading(true);
    setLoadError('');
    try {
      setSummary(await getCheckoutSummary(signal));
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setSummary(undefined);
      setLoadError(
        error instanceof CheckoutApiError && error.code === 'CHECKOUT_CART_EMPTY'
          ? 'Tu carrito está vacío.'
          : error instanceof Error
            ? error.message
            : 'No fue posible cargar el resumen',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.role !== 'CLIENTE') return;
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [user?.id, user?.role]);

  async function send(request: PlaceOrderRequest): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setNotice(undefined);
    setConflicts([]);
    lastRequest.current = request;
    try {
      const { order } = await placeOrder(request, keyRef.current);
      keyRef.current = newKey();
      lastRequest.current = undefined;
      await reloadCart();
      window.location.hash = `#/checkout/confirmacion/${order.id}`;
    } catch (error: unknown) {
      const failure =
        error instanceof CheckoutApiError
          ? error
          : new CheckoutApiError('No fue posible confirmar el pedido', 0, undefined);
      if (failure.code && PENDING_CODES.has(failure.code)) {
        setNotice({
          kind: 'pending',
          text: 'La confirmación quedó pendiente de verificación. Reintenta: no se duplicará el pedido.',
        });
        return;
      }
      // Resultado final: la siguiente confirmación es un intento nuevo con otra clave.
      keyRef.current = newKey();
      lastRequest.current = undefined;
      if (failure.code === 'PAYMENT_SIMULATED_REJECTED') {
        setNotice({
          kind: 'error',
          text: 'El pago simulado fue rechazado. Tu carrito se conserva; puedes confirmar de nuevo.',
        });
      } else if (failure.code === 'CHECKOUT_SUMMARY_CHANGED') {
        await loadSummary();
        setNotice({
          kind: 'info',
          text: 'Los precios o cantidades cambiaron. Revisa el nuevo total y confirma de nuevo.',
        });
      } else if (failure.code === 'CHECKOUT_STOCK_CONFLICT') {
        setConflicts(failure.conflicts);
        await loadSummary();
        setNotice({
          kind: 'error',
          text: 'Algunas líneas no tienen stock suficiente. Ajusta tu carrito para continuar.',
        });
      } else {
        setNotice({ kind: 'error', text: failure.message });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!summary || submitting) return;
    const { errors: found, value } = validateShipping(form);
    setErrors(found);
    if (!value) return;
    void send({ ...value, simulatedPaymentResult: payment, cartFingerprint: summary.fingerprint });
  }

  function field(name: ShippingField, label: string, input: ReactElement) {
    return (
      <label className={errors[name] ? 'field-invalid' : undefined}>
        {label}
        {input}
        {errors[name] && <span className="field-error">{errors[name]}</span>}
      </label>
    );
  }

  const update = (name: ShippingField) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [name]: event.target.value }));

  if (authLoading || (loading && !summary && !loadError && user?.role === 'CLIENTE')) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <span className="spinner" />
          Calculando resumen…
        </div>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="cart-page">
        <div className="state-card">
          <h1>Inicia sesión para confirmar tu pedido</h1>
          <a className="primary-link" href="#/login?returnTo=%23%2Fcheckout">
            Ingresar
          </a>
        </div>
      </main>
    );
  }
  if (user.role !== 'CLIENTE') {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>Acceso no permitido</h1>
        </div>
      </main>
    );
  }
  if (!summary) {
    return (
      <main className="cart-page">
        <div className="state-card error-state">
          <h1>No es posible continuar con el checkout</h1>
          <p>{loadError}</p>
          <a className="primary-link" href="#/carrito">
            Volver al carrito
          </a>
        </div>
      </main>
    );
  }

  const names = new Map(summary.items.map((item) => [item.productId, item.name]));
  const blocked = !summary.checkoutAllowed && notice?.kind !== 'pending';

  return (
    <main className="cart-page">
      <section className="cart-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">M04 · Checkout simulado</p>
            <h1>Confirma tu pedido</h1>
          </div>
          <a className="back-link" href="#/carrito">
            Volver al carrito
          </a>
        </div>
        <div className="cart-layout">
          <form id="checkout-form" className="checkout-form" onSubmit={submit} noValidate>
            <p className="checkout-warning" role="note">
              Laboratorio académico: usa únicamente datos de entrega <strong>ficticios</strong>. No
              se solicitan ni almacenan datos de tarjeta.
            </p>
            <fieldset disabled={submitting}>
              <legend>Datos de entrega ficticios</legend>
              <div className="checkout-grid">
                {field(
                  'recipientName',
                  'Nombre de quien recibe',
                  <input
                    value={form.recipientName}
                    onChange={update('recipientName')}
                    maxLength={80}
                    autoComplete="off"
                  />,
                )}
                {field(
                  'phone',
                  'Teléfono (ficticio)',
                  <input
                    value={form.phone}
                    onChange={update('phone')}
                    inputMode="numeric"
                    placeholder="5555-0101"
                    maxLength={9}
                    autoComplete="off"
                  />,
                )}
                {field(
                  'department',
                  'Departamento',
                  <select value={form.department} onChange={update('department')}>
                    <option value="">Selecciona…</option>
                    {GUATEMALA_DEPARTMENTS.map((department) => (
                      <option key={department} value={department}>
                        {department}
                      </option>
                    ))}
                  </select>,
                )}
                {field(
                  'municipality',
                  'Municipio',
                  <input
                    value={form.municipality}
                    onChange={update('municipality')}
                    maxLength={60}
                    autoComplete="off"
                  />,
                )}
                {field(
                  'address',
                  'Dirección',
                  <input
                    value={form.address}
                    onChange={update('address')}
                    maxLength={150}
                    autoComplete="off"
                  />,
                )}
                {field(
                  'references',
                  'Referencias (opcional)',
                  <input
                    value={form.references}
                    onChange={update('references')}
                    maxLength={200}
                    autoComplete="off"
                  />,
                )}
              </div>
            </fieldset>
            <fieldset disabled={submitting} className="payment-choice">
              <legend>Resultado del pago simulado</legend>
              {(['APROBADO', 'RECHAZADO'] as const).map((option) => (
                <label key={option} className="check-field">
                  <input
                    type="radio"
                    name="simulatedPaymentResult"
                    value={option}
                    checked={payment === option}
                    onChange={() => setPayment(option)}
                  />
                  {option === 'APROBADO' ? 'Aprobar pago simulado' : 'Rechazar pago simulado'}
                </label>
              ))}
            </fieldset>
            {notice && (
              <div className={`form-message notice-${notice.kind}`} role="alert">
                <p>{notice.text}</p>
                {conflicts.length > 0 && (
                  <ul>
                    {conflicts.map((conflict) => (
                      <li key={conflict.productId}>
                        {names.get(conflict.productId) ?? 'Producto'} {REASONS[conflict.reason]}
                        {conflict.reason === 'INSUFFICIENT_STOCK'
                          ? ` (disponible: ${conflict.available})`
                          : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {notice.kind === 'pending' && lastRequest.current && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={submitting}
                    onClick={() => void send(lastRequest.current!)}
                  >
                    Reintentar confirmación
                  </button>
                )}
                {conflicts.length > 0 && <a href="#/carrito">Ajustar carrito</a>}
              </div>
            )}
          </form>
          <aside className="cart-summary" aria-live="polite">
            <p>Resumen recalculado en servidor</p>
            <ul className="checkout-lines">
              {summary.items.map((item) => (
                <li key={item.productId} className={item.available ? '' : 'line-unavailable'}>
                  <span>
                    {item.quantity} × {item.name}
                  </span>
                  <span>{item.available ? formatPrice(item.subtotal) : 'No disponible'}</span>
                </li>
              ))}
            </ul>
            <strong>{formatPrice(summary.total)}</strong>
            {summary.checkoutInProgress && (
              <p className="cart-warning">Hay una confirmación en curso para este carrito.</p>
            )}
            {!summary.checkoutAllowed && !summary.checkoutInProgress && (
              <p className="cart-warning">Resuelve las líneas no disponibles en el carrito.</p>
            )}
            <button
              className="primary-button"
              type="submit"
              form="checkout-form"
              disabled={submitting || blocked}
            >
              {submitting ? 'Confirmando…' : 'Confirmar pedido'}
            </button>
            <small>Clave del intento: {keyRef.current.slice(0, 8)}…</small>
          </aside>
        </div>
      </section>
    </main>
  );
}
