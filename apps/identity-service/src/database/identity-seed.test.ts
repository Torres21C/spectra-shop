import type { PrismaClient } from '../generated/identity-client/index.js';
import { describe, expect, it } from 'vitest';
import { seedIdentity } from './identity-seed.js';

interface RoleRow {
  id: string;
  code: string;
  name: string;
}

interface UserRow {
  fullName: string;
  emailNormalized: string;
  passwordHash: string;
  roleId: string;
}

interface RoleUpsertArgs {
  where: { code: string };
  create: RoleRow;
  update: Partial<RoleRow>;
}

interface UserUpsertArgs {
  where: { emailNormalized: string };
  create: UserRow;
  update: Partial<UserRow>;
}

function inMemoryIdentity() {
  const roles = new Map<string, RoleRow>();
  const users = new Map<string, UserRow>();
  const client = {
    role: {
      upsert({ where, create, update }: RoleUpsertArgs): Promise<RoleRow> {
        const row = roles.has(where.code)
          ? { ...roles.get(where.code)!, ...update }
          : { ...create };
        roles.set(where.code, row);
        return Promise.resolve({ ...row });
      },
    },
    user: {
      upsert({ where, create, update }: UserUpsertArgs): Promise<UserRow> {
        const row = users.has(where.emailNormalized)
          ? { ...users.get(where.emailNormalized)!, ...update }
          : { ...create };
        users.set(where.emailNormalized, row);
        return Promise.resolve({ ...row });
      },
    },
  } as unknown as PrismaClient;
  return { client, roles, users };
}

describe('identity synthetic seed', () => {
  it('is idempotent and never replaces an existing synthetic ADMIN password', async () => {
    const { client, roles, users } = inMemoryIdentity();
    await seedIdentity(client, {
      email: ' Admin@Spectra.Test ',
      password: 'first-synthetic-password',
    });
    const firstAdmin = structuredClone(users.get('admin@spectra.test')!);

    await seedIdentity(client, {
      email: 'admin@spectra.test',
      password: 'different-synthetic-password',
    });

    expect([...roles.values()]).toEqual([
      { id: '10000000-0000-4000-8000-000000000001', code: 'CLIENTE', name: 'Cliente' },
      { id: '10000000-0000-4000-8000-000000000002', code: 'ADMIN', name: 'Administrador' },
    ]);
    expect(users).toHaveLength(1);
    expect(users.get('admin@spectra.test')).toEqual(firstAdmin);
  });

  it('creates only the roles when no synthetic ADMIN is configured', async () => {
    const { client, roles, users } = inMemoryIdentity();
    await seedIdentity(client);
    await seedIdentity(client);
    expect(roles).toHaveLength(2);
    expect(users).toHaveLength(0);
  });

  it('normalizes the names of pre-existing roles without changing their ids', async () => {
    const { client, roles } = inMemoryIdentity();
    roles.set('CLIENTE', {
      id: '10000000-0000-4000-8000-000000000001',
      code: 'CLIENTE',
      name: 'x',
    });
    roles.set('ADMIN', { id: '10000000-0000-4000-8000-000000000002', code: 'ADMIN', name: 'y' });
    await seedIdentity(client);
    expect(roles.get('CLIENTE')?.name).toBe('Cliente');
    expect(roles.get('ADMIN')?.name).toBe('Administrador');
    expect(roles.get('ADMIN')?.id).toBe('10000000-0000-4000-8000-000000000002');
  });

  it('rejects partial or weak synthetic ADMIN configuration', async () => {
    const { client } = inMemoryIdentity();
    await expect(seedIdentity(client, { email: 'admin@spectra.test' })).rejects.toThrow(
      'contraseña de al menos 16 caracteres',
    );
    await expect(
      seedIdentity(client, { email: 'admin@spectra.test', password: 'too-short' }),
    ).rejects.toThrow('contraseña de al menos 16 caracteres');
  });
});
