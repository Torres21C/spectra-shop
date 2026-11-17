#!/usr/bin/env node
/**
 * Smoke E2E del MVP (registro → login → catálogo → carrito → checkout → pedido → historial).
 *
 * Reproduce las mismas llamadas HTTP que hace la Web desde el navegador: cabecera Origin de la Web,
 * cookies de sesión compartidas por host (como el navegador entre puertos de 127.0.0.1), token CSRF de
 * Identity y clave Idempotency-Key en la confirmación. No usa credenciales internas ni la base de datos.
 *
 * ESCRIBE DATOS (usuario, carrito, pedido, reserva de stock). Por eso no tiene URLs por defecto: hay que
 * apuntarlo explícitamente a un stack aislado con datos sintéticos, nunca al entorno principal.
 *
 *   SPECTRA_E2E_IDENTITY_URL=http://127.0.0.1:13001 \
 *   SPECTRA_E2E_CATALOG_URL=http://127.0.0.1:13002 \
 *   SPECTRA_E2E_COMMERCE_URL=http://127.0.0.1:13003 \
 *   node scripts/mvp-e2e-smoke.mjs
 *
 * Imprime un informe JSON (sin cookies ni tokens) y termina con código 1 ante el primer fallo.
 */
import { randomUUID } from 'node:crypto';

const IDENTITY = process.env.SPECTRA_E2E_IDENTITY_URL;
const CATALOG = process.env.SPECTRA_E2E_CATALOG_URL;
const COMMERCE = process.env.SPECTRA_E2E_COMMERCE_URL;
const ORIGIN = process.env.SPECTRA_E2E_ORIGIN ?? 'http://127.0.0.1:5173';

if (!IDENTITY || !CATALOG || !COMMERCE) {
  console.error(
    'Defina SPECTRA_E2E_IDENTITY_URL, SPECTRA_E2E_CATALOG_URL y SPECTRA_E2E_COMMERCE_URL (stack aislado).',
  );
  process.exit(2);
}

/** Tarro de cookies mínimo: host-only (el navegador las comparte entre puertos) y respeta Path. */
const jar = new Map();
function storeCookies(response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const pathAttribute = attributes.find((attribute) => /^path=/i.test(attribute));
    const path = pathAttribute ? pathAttribute.slice(5) : '/';
    const expired = attributes.some(
      (attribute) => /^max-age=0$/i.test(attribute) || /^expires=thu, 01 jan 1970/i.test(attribute),
    );
    const key = `${name};${path}`;
    if (expired || value === '') jar.delete(key);
    else jar.set(key, { name, value, path });
  }
}
function cookieHeader(url) {
  const { pathname } = new URL(url);
  return [...jar.values()]
    .filter((cookie) => pathname.startsWith(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function call(base, path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${base}${path}`;
  const cookies = cookieHeader(url);
  const response = await fetch(url, {
    method,
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Origin: ORIGIN,
      ...(cookies ? { Cookie: cookies } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  storeCookies(response);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

async function csrf() {
  const { status, payload } = await call(IDENTITY, '/auth/csrf');
  expect(status === 200 && typeof payload?.csrfToken === 'string', 'CSRF', status, payload);
  return payload.csrfToken;
}

const report = { startedAt: new Date().toISOString(), steps: [] };
function expect(condition, step, status, payload) {
  if (!condition) {
    report.steps.push({ step, result: 'FAIL', status, payload });
    report.verdict = 'FAIL';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}
function pass(step, details = {}) {
  report.steps.push({ step, result: 'PASS', ...details });
}

const stamp = Date.now();
const email = `mvp.e2e.${stamp}@example.test`;
const password = `Sintetica-${randomUUID().slice(0, 12)}`;

// 1. Registro
{
  const token = await csrf();
  const { status, payload } = await call(IDENTITY, '/auth/register', {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: {
      fullName: 'Cliente Sintetico MVP',
      email,
      password,
      passwordConfirmation: password,
      academicDataAccepted: true,
    },
  });
  expect(status === 201 || status === 200, '1. Registro', status, payload);
  pass('1. Registro', { status, email });
}

// 2. Login + sesión
{
  const token = await csrf();
  const { status, payload } = await call(IDENTITY, '/auth/login', {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: { email, password, returnTo: '#/pedidos' },
  });
  expect(
    status >= 200 && status < 300 && payload?.user?.role === 'CLIENTE',
    '2. Login',
    status,
    payload,
  );
  const me = await call(IDENTITY, '/auth/me');
  expect(
    me.status === 200 && me.payload?.email === email,
    '2. Sesión /auth/me',
    me.status,
    me.payload,
  );
  pass('2. Login y sesión', { status, role: payload.user.role, userId: payload.user.id });
}

// 3. Catálogo
let products;
{
  const categories = await call(CATALOG, '/categories');
  expect(
    categories.status === 200 && Array.isArray(categories.payload) && categories.payload.length > 0,
    '3. Categorías',
    categories.status,
    categories.payload,
  );
  const page = await call(CATALOG, '/products?page=1');
  expect(
    page.status === 200 && page.payload?.items?.length > 0,
    '3. Productos',
    page.status,
    page.payload,
  );
  products = page.payload.items.filter((item) => item.availability === 'AVAILABLE');
  expect(products.length >= 2, '3. Productos disponibles', page.status, page.payload.meta);
  pass('3. Categorías y productos', {
    categories: categories.payload.length,
    productsTotal: page.payload.meta.totalItems,
  });
}

// 4. Detalle
const [first, second] = products;
{
  const { status, payload } = await call(CATALOG, `/products/${first.id}`);
  expect(status === 200 && payload?.id === first.id && payload?.sku, '4. Detalle', status, payload);
  pass('4. Detalle de producto', { productId: first.id, sku: payload.sku, name: payload.name });
}

async function mutateCart(method, path, body) {
  const token = await csrf();
  return call(COMMERCE, path, { method, headers: { 'X-CSRF-Token': token }, body });
}

// 5-6. Carrito: agregar, modificar, eliminar
let cart;
{
  let response = await mutateCart('POST', '/cart/items', { productId: first.id, quantity: 1 });
  expect(
    response.status < 300 && response.payload?.items?.length === 1,
    '5. Agregar #1',
    response.status,
    response.payload,
  );
  response = await mutateCart('POST', '/cart/items', { productId: second.id, quantity: 1 });
  expect(
    response.status < 300 && response.payload?.items?.length === 2,
    '5. Agregar #2',
    response.status,
    response.payload,
  );
  const firstLine = response.payload.items.find((line) => line.productId === first.id);
  const secondLine = response.payload.items.find((line) => line.productId === second.id);
  response = await mutateCart('PATCH', `/cart/items/${firstLine.id}`, { quantity: 2 });
  expect(
    response.status < 300 &&
      response.payload.items.find((line) => line.id === firstLine.id)?.quantity === 2,
    '6. Modificar cantidad',
    response.status,
    response.payload,
  );
  response = await mutateCart('DELETE', `/cart/items/${secondLine.id}`);
  expect(
    response.status < 300 && response.payload?.items?.length === 1,
    '6. Eliminar línea',
    response.status,
    response.payload,
  );
  const view = await call(COMMERCE, '/cart');
  expect(
    view.status === 200 && view.payload.itemCount === 2 && view.payload.checkoutAllowed,
    '6. Ver carrito',
    view.status,
    view.payload,
  );
  cart = view.payload;
  pass('5-6. Carrito (agregar, modificar, eliminar, ver)', {
    itemCount: cart.itemCount,
    total: cart.total,
    productId: first.id,
  });
}

// 7-8. Checkout simulado con idempotencia
let order;
{
  const summary = await call(COMMERCE, '/checkout/summary');
  expect(
    summary.status === 200 && summary.payload?.checkoutAllowed,
    '7. Resumen checkout',
    summary.status,
    summary.payload,
  );
  const request = {
    recipientName: 'Cliente Sintetico',
    phone: '5555-0101',
    department: 'Guatemala',
    municipality: 'Guatemala',
    address: 'Zona 1, dirección sintética de laboratorio',
    simulatedPaymentResult: 'APROBADO',
    cartFingerprint: summary.payload.fingerprint,
  };
  const key = randomUUID();
  const firstTry = await mutateCart('POST', '/orders', undefined);
  // Sin cuerpo ni clave debe rechazarse (validación), nunca crear pedido.
  expect(
    firstTry.status >= 400 && firstTry.status < 500,
    '7. Rechazo sin datos',
    firstTry.status,
    firstTry.payload,
  );

  const token = await csrf();
  const created = await call(COMMERCE, '/orders', {
    method: 'POST',
    headers: { 'X-CSRF-Token': token, 'Idempotency-Key': key },
    body: request,
  });
  expect(
    created.status === 201 && created.payload?.status === 'PAGADO',
    '7. Checkout',
    created.status,
    created.payload,
  );
  order = created.payload;

  const replayToken = await csrf();
  const replay = await call(COMMERCE, '/orders', {
    method: 'POST',
    headers: { 'X-CSRF-Token': replayToken, 'Idempotency-Key': key },
    body: request,
  });
  expect(
    replay.status === 200 && replay.payload?.id === order.id,
    '8. Reintento idempotente (misma clave)',
    replay.status,
    replay.payload,
  );
  pass('7. Checkout simulado', {
    status: created.status,
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    total: order.total,
    paymentReference: order.paymentReference,
  });
  pass('8. Idempotencia (mismo pedido, sin duplicado)', {
    replayStatus: replay.status,
    sameOrderId: true,
  });
}

// 9-10. Confirmación, consulta e historial; carrito vacío tras convertir
{
  const detail = await call(COMMERCE, `/orders/${order.id}`);
  expect(
    detail.status === 200 && detail.payload?.id === order.id,
    '9. Consulta pedido',
    detail.status,
    detail.payload,
  );
  const history = await call(COMMERCE, '/orders?page=1');
  const listed = history.payload?.items?.filter((item) => item.id === order.id) ?? [];
  expect(
    history.status === 200 && listed.length === 1 && history.payload.meta.totalItems === 1,
    '10. Historial (un solo pedido)',
    history.status,
    history.payload,
  );
  const after = await call(COMMERCE, '/cart');
  expect(
    after.status === 200 && after.payload.itemCount === 0,
    '10. Carrito vacío tras checkout',
    after.status,
    after.payload,
  );
  pass('9-10. Confirmación, detalle e historial', {
    detailStatus: detail.payload.status,
    historyTotal: history.payload.meta.totalItems,
    cartItemsAfter: after.payload.itemCount,
  });
}

// 11. Logout
{
  const token = await csrf();
  const { status } = await call(IDENTITY, '/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: {},
  });
  const me = await call(IDENTITY, '/auth/me');
  expect(status < 300 && me.status === 401, '11. Logout', status, me.payload);
  pass('11. Logout', { status, meAfter: me.status });
}

report.verdict = 'PASS';
report.finishedAt = new Date().toISOString();
report.userId = report.steps[1].userId;
report.orderId = order.id;
report.productId = first.id;
report.purchasedQuantity = 2;
console.log(JSON.stringify(report, null, 2));
