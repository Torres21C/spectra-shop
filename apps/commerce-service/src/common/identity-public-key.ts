import { readFile } from 'node:fs/promises';

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----';

/**
 * AD-08 / AWS-01: clave pública ES256 de Identity. En local llega como archivo
 * (IDENTITY_PUBLIC_KEY_PATH); en AWS, como PEM en IDENTITY_PUBLIC_KEY_PEM (es la clave pública de la
 * clave KMS de firma, no un secreto). Exactamente una de las dos.
 */
export function identityPublicKeySource(
  env: NodeJS.ProcessEnv = process.env,
): { readonly pem: string } | { readonly path: string } {
  const inline = env.IDENTITY_PUBLIC_KEY_PEM?.trim();
  const path = env.IDENTITY_PUBLIC_KEY_PATH?.trim();
  if (inline && path) {
    throw new Error('Defina solo una de IDENTITY_PUBLIC_KEY_PEM o IDENTITY_PUBLIC_KEY_PATH');
  }
  if (inline) {
    // Admite saltos de línea reales o escapados (\n) según cómo se inyecte la variable.
    const pem = inline.replace(/\\n/g, '\n');
    if (!pem.startsWith(PEM_HEADER)) {
      throw new Error('IDENTITY_PUBLIC_KEY_PEM debe ser una clave pública PEM (SPKI)');
    }
    return { pem };
  }
  if (path) return { path };
  throw new Error('IDENTITY_PUBLIC_KEY_PEM o IDENTITY_PUBLIC_KEY_PATH es obligatorio');
}

export async function readIdentityPublicKeyPem(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const source = identityPublicKeySource(env);
  return 'pem' in source ? source.pem : readFile(source.path, 'utf8');
}
