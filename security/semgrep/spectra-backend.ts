// CASOS DE PRUEBA SINTÉTICOS (datos de laboratorio) para spectra-backend.yaml.
// No es código de la aplicación. Ejecutar: semgrep --test 04-Fase-3/config/semgrep/

// --- RS03: SQL
async function buscar(prisma: any, db: any, term: string) {
  // ruleid: spectra-prisma-raw-unsafe
  await prisma.$queryRawUnsafe(`SELECT * FROM products WHERE name LIKE '%${term}%'`);
  // ok: spectra-prisma-raw-unsafe
  await prisma.$queryRaw`SELECT * FROM products WHERE name ILIKE ${'%' + term + '%'}`;
  // ruleid: spectra-sql-string-building
  await db.query("SELECT * FROM products WHERE name = '" + term + "'");
  // ruleid: spectra-sql-string-building
  await db.query(`SELECT * FROM orders WHERE id = ${term}`);
  // ok: spectra-sql-string-building
  await db.query('SELECT * FROM products WHERE name = $1', [term]);
}

// --- RS01: JWT
function verificar(jwt: any, token: string, publicKey: string) {
  // ruleid: spectra-jwt-verify-without-algorithms
  jwt.verify(token, publicKey);
  // ruleid: spectra-jwt-verify-without-algorithms
  jwt.verify(token, publicKey, { issuer: 'spectra' });
  // ok: spectra-jwt-verify-without-algorithms
  jwt.verify(token, publicKey, { algorithms: ['ES256'], issuer: 'spectra' });
}

// Falso positivo detectado al escanear los ejemplos: argon2.verify no es un JWT
async function verificarPassword(argon2: any, hash: string, password: string) {
  // ok: spectra-jwt-verify-without-algorithms
  return argon2.verify(hash, password);
}

// --- RS01: cookies
function emitirCookie(res: any, value: string) {
  // ruleid: spectra-cookie-without-httponly, spectra-cookie-without-secure
  res.cookie('__Host-access', value);
  // ruleid: spectra-cookie-without-httponly
  res.cookie('__Host-access', value, { secure: true, sameSite: 'strict' });
  // ok: spectra-cookie-without-httponly, spectra-cookie-without-secure
  res.cookie('__Host-access', value, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });
}

// --- RS09: ValidationPipe
function pipes(ValidationPipe: any) {
  // ruleid: spectra-validationpipe-without-whitelist
  const a = new ValidationPipe();
  // ruleid: spectra-validationpipe-without-whitelist
  const b = new ValidationPipe({ whitelist: true });
  // ok: spectra-validationpipe-without-whitelist
  const c = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  return [a, b, c];
}

// --- RS07: logs
function registrar(logger: any, req: any, dto: any) {
  // ruleid: spectra-sensitive-data-in-logs
  logger.info('login', dto.password);
  // ruleid: spectra-sensitive-data-in-logs
  logger.debug('request', req.body);
  // ruleid: spectra-sensitive-data-in-logs
  console.log(req.headers.authorization);
  // ok: spectra-sensitive-data-in-logs
  logger.info('login', { userId: dto.userId, correlationId: req.id });
}

// --- RS11: errores
function manejarError(res: any, err: any, correlationId: string) {
  // ruleid: spectra-stack-trace-in-response
  res.status(500).json({ message: err.message, stack: err.stack });
  // ok: spectra-stack-trace-in-response
  res.status(500).json({ message: 'Error interno', correlationId });
}

// --- RS01: hash y aleatoriedad
function criptografia(crypto: any) {
  // ruleid: spectra-weak-hash
  crypto.createHash('md5');
  // ok: spectra-weak-hash
  crypto.createHash('sha256');
  // ruleid: spectra-insecure-random-token
  const t = Math.random().toString(36);
  // ok: spectra-insecure-random-token
  const u = crypto.randomUUID();
  return [t, u];
}

// --- RS09: ejecución dinámica
function dinamico(code: string) {
  // ruleid: spectra-dynamic-code-execution
  eval(code);
  // ruleid: spectra-dynamic-code-execution
  return new Function(code);
}
