// DT-09 (M06.0): verificación automatizada del aislamiento PostgreSQL por servicio.
//
// Se ejecuta con los seis roles de servicio (nunca con el administrador) y comprueba:
//   1. Atributos de rol y ausencia de pertenencias entre roles.
//   2. Privilegios de PUBLIC sobre la base y los esquemas.
//   3. La matriz exacta de privilegios de tabla y columna de cada rol en cada esquema.
//   4. Comportamiento real: operaciones permitidas y denegadas (DDL, TRUNCATE, `_prisma_migrations`,
//      esquemas ajenos, TEMP, `public`, SET ROLE), siempre dentro de transacciones revertidas.
//
// Variables: IDENTITY_APP_URL, IDENTITY_MIGRATOR_URL, CATALOG_APP_URL, CATALOG_MIGRATOR_URL,
// COMMERCE_APP_URL, COMMERCE_MIGRATOR_URL. Nunca imprime URLs ni credenciales.
// Salida: una línea JSON por comprobación y un resumen final; código 1 si alguna falla.
import pg from 'pg';

const INSUFFICIENT_PRIVILEGE = '42501';
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** Matriz esperada para cada rol de ejecución (debe coincidir con prisma/runtime-grants.sql). */
const SERVICES = {
  identity: {
    runtime: 'spectra_identity_app',
    migrator: 'spectra_identity_migrator',
    appUrl: 'IDENTITY_APP_URL',
    migratorUrl: 'IDENTITY_MIGRATOR_URL',
    grants: {
      roles: ['SELECT'],
      users: ['SELECT', 'INSERT', 'UPDATE'],
      auth_sessions: ['SELECT', 'INSERT', 'UPDATE'],
      refresh_tokens: ['SELECT', 'INSERT', 'UPDATE'],
      outbox_events: ['SELECT', 'INSERT'],
      _prisma_migrations: [],
    },
    columnUpdates: {},
    sequences: {},
    deniedWrite: 'DELETE FROM "identity"."users" WHERE false',
  },
  catalog: {
    runtime: 'spectra_catalog_app',
    migrator: 'spectra_catalog_migrator',
    appUrl: 'CATALOG_APP_URL',
    migratorUrl: 'CATALOG_MIGRATOR_URL',
    grants: {
      categories: ['SELECT'],
      products: ['SELECT'],
      stock_reservations: ['SELECT', 'INSERT', 'UPDATE'],
      stock_reservation_lines: ['SELECT', 'INSERT'],
      _prisma_migrations: [],
    },
    // Actualización por columnas: solo stock y marca temporal.
    columnUpdates: {
      products: { allowed: ['stock', 'updated_at'], denied: ['price', 'is_active', 'name'] },
    },
    sequences: {},
    deniedWrite: 'UPDATE "catalog"."products" SET "price" = "price" WHERE false',
  },
  commerce: {
    runtime: 'spectra_commerce_app',
    migrator: 'spectra_commerce_migrator',
    appUrl: 'COMMERCE_APP_URL',
    migratorUrl: 'COMMERCE_MIGRATOR_URL',
    grants: {
      carts: ['SELECT', 'INSERT', 'UPDATE'],
      cart_items: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      checkout_attempts: ['SELECT', 'INSERT', 'UPDATE'],
      orders: ['SELECT', 'INSERT'],
      order_items: ['SELECT', 'INSERT'],
      outbox_events: ['SELECT', 'INSERT'],
      _prisma_migrations: [],
    },
    columnUpdates: {},
    sequences: { order_number_seq: { USAGE: true, SELECT: false, UPDATE: false } },
    deniedWrite: 'UPDATE "commerce"."orders" SET "status" = "status" WHERE false',
  },
};
const ALL_ROLES = Object.values(SERVICES).flatMap((s) => [s.runtime, s.migrator]);

const results = [];
function record(check, ok, detail = {}) {
  results.push({ check, ok, ...detail });
  console.log(JSON.stringify({ check, ok, ...detail }));
}

function connect(variable) {
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`Falta la variable ${variable}`);
  const url = new URL(connectionString);
  url.searchParams.delete('schema'); // parámetro de Prisma, no de libpq
  return new pg.Client({ connectionString: url.toString(), application_name: 'dt09-isolation' });
}

/** Ejecuta `sql` en una transacción revertida y devuelve el SQLSTATE (o 'OK'). */
async function attempt(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    return 'OK';
  } catch (error) {
    return error.code ?? 'ERROR';
  } finally {
    await client.query('ROLLBACK');
  }
}

async function expectDenied(client, role, label, sql) {
  const code = await attempt(client, sql);
  record(`${role}: deniega ${label}`, code === INSUFFICIENT_PRIVILEGE, { sqlstate: code });
}

async function expectAllowed(client, role, label, sql) {
  const code = await attempt(client, sql);
  record(`${role}: permite ${label}`, code === 'OK', { sqlstate: code });
}

async function verifyGlobal(client, database) {
  const { rows: roles } = await client.query(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
    [ALL_ROLES],
  );
  record('existen los seis roles de servicio', roles.length === ALL_ROLES.length, {
    found: roles.length,
  });
  for (const role of roles) {
    const elevated = [
      'rolsuper',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
      'rolbypassrls',
    ].filter((attribute) => role[attribute]);
    record(
      `${role.rolname}: LOGIN sin atributos elevados`,
      role.rolcanlogin && elevated.length === 0,
      {
        elevated,
      },
    );
  }
  const { rows: memberships } = await client.query(
    `SELECT count(*)::int AS n FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
      WHERE r.rolname = ANY($1) OR m.rolname = ANY($1)`,
    [ALL_ROLES],
  );
  record('sin pertenencias entre roles de servicio ni hacia otros roles', memberships[0].n === 0, {
    memberships: memberships[0].n,
  });

  const { rows: pub } = await client.query(
    `SELECT has_database_privilege('public', $1, 'CONNECT') AS connect,
            has_database_privilege('public', $1, 'TEMP') AS temp,
            has_database_privilege('public', $1, 'CREATE') AS create,
            has_schema_privilege('public', 'public', 'CREATE') AS public_schema_create`,
    [database],
  );
  record(
    'PUBLIC sin CONNECT/TEMP/CREATE en la base ni CREATE en public',
    Object.values(pub[0]).every((v) => !v),
    pub[0],
  );

  for (const role of ALL_ROLES) {
    const { rows } = await client.query(
      `SELECT has_database_privilege($1, $2, 'CONNECT') AS connect,
              has_database_privilege($1, $2, 'TEMP') AS temp,
              has_database_privilege($1, $2, 'CREATE') AS create`,
      [role, database],
    );
    record(
      `${role}: solo CONNECT sobre la base`,
      rows[0].connect && !rows[0].temp && !rows[0].create,
      rows[0],
    );
  }

  for (const [schema, service] of Object.entries(SERVICES)) {
    const { rows } = await client.query(
      `SELECT pg_get_userbyid(nspowner) AS owner, has_schema_privilege('public', oid, 'USAGE') AS public_usage
         FROM pg_namespace WHERE nspname = $1`,
      [schema],
    );
    record(
      `esquema ${schema}: propiedad del migrador y sin USAGE para PUBLIC`,
      rows[0]?.owner === service.migrator && rows[0]?.public_usage === false,
      rows[0] ?? {},
    );
    for (const role of ALL_ROLES) {
      const { rows: priv } = await client.query(
        `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage, has_schema_privilege($1, $2, 'CREATE') AS create`,
        [role, schema],
      );
      const isMigrator = role === service.migrator;
      const isRuntime = role === service.runtime;
      const ok = isMigrator
        ? priv[0].usage && priv[0].create
        : isRuntime
          ? priv[0].usage && !priv[0].create
          : !priv[0].usage && !priv[0].create;
      record(`${role}: privilegios esperados sobre el esquema ${schema}`, ok, priv[0]);
    }
  }

  const { rows: defaults } = await client.query(
    `SELECT pg_get_userbyid(defaclrole) AS role, defaclobjtype, defaclacl::text AS acl
       FROM pg_default_acl WHERE pg_get_userbyid(defaclrole) = ANY($1)`,
    [ALL_ROLES],
  );
  for (const service of Object.values(SERVICES)) {
    const entry = defaults.find((d) => d.role === service.migrator && d.defaclobjtype === 'f');
    // La ACL por defecto concede EXECUTE solo al propietario: no hay entrada `=X/` para PUBLIC.
    record(
      `${service.migrator}: DEFAULT PRIVILEGES sin EXECUTE de PUBLIC en funciones`,
      Boolean(entry) && !/(^|[{,])=X/.test(entry.acl),
      { acl: entry?.acl ?? null },
    );
  }
  const runtimeDefaults = defaults.filter(
    (d) => !Object.values(SERVICES).some((s) => s.migrator === d.role),
  );
  record(
    'sin DEFAULT PRIVILEGES que concedan permisos futuros a roles de ejecución',
    runtimeDefaults.length === 0,
    {
      entries: runtimeDefaults.length,
    },
  );
}

/** Con el migrador (propietario) se calcula la matriz efectiva de todos los roles en su esquema. */
async function verifyMatrix(migrator, schema, service) {
  const { rows: tables } = await migrator.query(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname`,
    [schema],
  );
  const expectedTables = Object.keys(service.grants).sort();
  const actualTables = tables
    .filter((t) => t.relkind !== 'S')
    .map((t) => t.relname)
    .sort();
  record(
    `esquema ${schema}: inventario de tablas cubierto por la matriz`,
    JSON.stringify(expectedTables) === JSON.stringify(actualTables),
    { expectedTables, actualTables },
  );
  for (const table of tables) {
    record(`${schema}.${table.relname}: propiedad del migrador`, table.owner === service.migrator, {
      owner: table.owner,
    });
  }
  for (const table of tables.filter((t) => t.relkind !== 'S')) {
    const qualified = `"${schema}"."${table.relname}"`;
    for (const role of [...ALL_ROLES, 'public']) {
      const { rows } = await migrator.query(
        `SELECT ${PRIVILEGES.map((p, i) => `has_table_privilege($1, $2::regclass, '${p}') AS p${i}`).join(', ')}`,
        [role, qualified],
      );
      const actual = PRIVILEGES.filter((_, i) => rows[0][`p${i}`]);
      const expected =
        role === service.migrator
          ? PRIVILEGES
          : role === service.runtime
            ? (service.grants[table.relname] ?? [])
            : [];
      record(
        `${role}: privilegios exactos en ${schema}.${table.relname}`,
        JSON.stringify(actual) === JSON.stringify(expected),
        { expected, actual },
      );
    }
  }
  for (const [table, columns] of Object.entries(service.columnUpdates)) {
    for (const column of [...columns.allowed, ...columns.denied]) {
      const { rows } = await migrator.query(
        `SELECT has_column_privilege($1, $2::regclass, $3, 'UPDATE') AS allowed`,
        [service.runtime, `"${schema}"."${table}"`, column],
      );
      const expected = columns.allowed.includes(column);
      record(
        `${service.runtime}: UPDATE de columna ${schema}.${table}.${column} = ${expected}`,
        rows[0].allowed === expected,
        { actual: rows[0].allowed },
      );
    }
  }
  for (const [sequence, expected] of Object.entries(service.sequences)) {
    for (const [privilege, allowed] of Object.entries(expected)) {
      const { rows } = await migrator.query(
        `SELECT has_sequence_privilege($1, $2::regclass, $3) AS allowed`,
        [service.runtime, `"${schema}"."${sequence}"`, privilege],
      );
      record(
        `${service.runtime}: ${privilege} en ${schema}.${sequence} = ${allowed}`,
        rows[0].allowed === allowed,
        {
          actual: rows[0].allowed,
        },
      );
    }
  }
}

async function verifyRuntimeBehaviour(client, schema, service) {
  const role = service.runtime;
  const { rows } = await client.query('SELECT current_user AS who');
  record(`${role}: conecta con su propia identidad`, rows[0].who === role, {
    currentUser: rows[0].who,
  });
  for (const [table, privileges] of Object.entries(service.grants)) {
    if (privileges.includes('SELECT')) {
      await expectAllowed(
        client,
        role,
        `SELECT en ${schema}.${table}`,
        `SELECT 1 FROM "${schema}"."${table}" LIMIT 1`,
      );
    }
  }
  const sample = Object.keys(service.grants).find((t) => t !== '_prisma_migrations');
  await expectDenied(
    client,
    role,
    `CREATE TABLE en ${schema}`,
    `CREATE TABLE "${schema}"."dt09_probe" (id int)`,
  );
  await expectDenied(
    client,
    role,
    `ALTER TABLE ${schema}.${sample}`,
    `ALTER TABLE "${schema}"."${sample}" ADD COLUMN "dt09_probe" int`,
  );
  await expectDenied(
    client,
    role,
    `DROP TABLE ${schema}.${sample}`,
    `DROP TABLE "${schema}"."${sample}"`,
  );
  await expectDenied(
    client,
    role,
    `TRUNCATE ${schema}.${sample}`,
    `TRUNCATE "${schema}"."${sample}"`,
  );
  await expectDenied(
    client,
    role,
    `lectura de ${schema}._prisma_migrations`,
    `SELECT 1 FROM "${schema}"."_prisma_migrations" LIMIT 1`,
  );
  await expectDenied(client, role, 'escritura no concedida', service.deniedWrite);
  await expectDenied(
    client,
    role,
    'CREATE TABLE en public',
    'CREATE TABLE public.dt09_probe (id int)',
  );
  await expectDenied(client, role, 'tabla temporal', 'CREATE TEMP TABLE dt09_probe (id int)');
  await expectDenied(client, role, 'CREATE SCHEMA', 'CREATE SCHEMA dt09_probe');
  await expectDenied(client, role, 'lectura de pg_authid', 'SELECT 1 FROM pg_authid LIMIT 1');
  for (const other of ALL_ROLES.filter((r) => r !== role)) {
    await expectDenied(client, role, `SET ROLE ${other}`, `SET ROLE "${other}"`);
  }
  for (const [otherSchema, other] of Object.entries(SERVICES)) {
    if (otherSchema === schema) continue;
    const table = Object.keys(other.grants).find((t) => t !== '_prisma_migrations');
    await expectDenied(
      client,
      role,
      `SELECT en esquema ajeno ${otherSchema}.${table}`,
      `SELECT 1 FROM "${otherSchema}"."${table}" LIMIT 1`,
    );
    await expectDenied(
      client,
      role,
      `INSERT en esquema ajeno ${otherSchema}.${table}`,
      `INSERT INTO "${otherSchema}"."${table}" DEFAULT VALUES`,
    );
  }
}

async function verifyMigratorBehaviour(client, schema, service) {
  const role = service.migrator;
  await expectAllowed(
    client,
    role,
    `CREATE TABLE en su esquema ${schema}`,
    `CREATE TABLE "${schema}"."dt09_probe" (id int)`,
  );
  await expectAllowed(
    client,
    role,
    `lectura de ${schema}._prisma_migrations`,
    `SELECT 1 FROM "${schema}"."_prisma_migrations" LIMIT 1`,
  );
  await expectDenied(client, role, 'CREATE SCHEMA', 'CREATE SCHEMA dt09_probe');
  await expectDenied(
    client,
    role,
    'CREATE TABLE en public',
    'CREATE TABLE public.dt09_probe (id int)',
  );
  await expectDenied(client, role, 'tabla temporal', 'CREATE TEMP TABLE dt09_probe (id int)');
  await expectDenied(client, role, 'lectura de pg_authid', 'SELECT 1 FROM pg_authid LIMIT 1');
  for (const other of ALL_ROLES.filter((r) => r !== role)) {
    await expectDenied(client, role, `SET ROLE ${other}`, `SET ROLE "${other}"`);
  }
  for (const [otherSchema, other] of Object.entries(SERVICES)) {
    if (otherSchema === schema) continue;
    const table = Object.keys(other.grants).find((t) => t !== '_prisma_migrations');
    await expectDenied(
      client,
      role,
      `SELECT en esquema ajeno ${otherSchema}.${table}`,
      `SELECT 1 FROM "${otherSchema}"."${table}" LIMIT 1`,
    );
    await expectDenied(
      client,
      role,
      `CREATE TABLE en esquema ajeno ${otherSchema}`,
      `CREATE TABLE "${otherSchema}"."dt09_probe" (id int)`,
    );
    await expectDenied(
      client,
      role,
      `ALTER TABLE en esquema ajeno ${otherSchema}.${table}`,
      `ALTER TABLE "${otherSchema}"."${table}" ADD COLUMN "dt09_probe" int`,
    );
  }
}

async function main() {
  const clients = [];
  try {
    for (const [schema, service] of Object.entries(SERVICES)) {
      const migrator = connect(service.migratorUrl);
      const runtime = connect(service.appUrl);
      clients.push(migrator, runtime);
      await migrator.connect();
      await runtime.connect();
      if (schema === 'identity') {
        const { rows } = await runtime.query('SELECT current_database() AS db');
        await verifyGlobal(runtime, rows[0].db);
      }
      await verifyMatrix(migrator, schema, service);
      await verifyRuntimeBehaviour(runtime, schema, service);
      await verifyMigratorBehaviour(migrator, schema, service);
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify({
      summary: 'DT-09 aislamiento PostgreSQL',
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    }),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  // Solo el código y el mensaje del error; nunca la cadena de conexión.
  console.error(
    JSON.stringify({
      fatal: true,
      code: error.code ?? null,
      message: String(error.message).replace(/postgres(ql)?:\/\/\S+/g, '<url>'),
    }),
  );
  process.exitCode = 2;
});
