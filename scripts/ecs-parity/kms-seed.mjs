#!/usr/bin/env node
/**
 * PR-7A: crea en el EMULADOR local de KMS la clave de firma de JWT del laboratorio (ECC_NIST_P256, SIGN_VERIFY)
 * y su alias, igual que `module.kms.aws_kms_key.jwt` de Terraform, e imprime en una sola línea JSON el ARN y la
 * clave pública PEM (equivalente a `data.aws_kms_public_key`). Es idempotente: si el alias existe, lo reutiliza.
 *
 * Se ejecuta dentro de la imagen runtime de identity-service (usa su @aws-sdk/client-kms) mediante el servicio
 * `kms-seed` de infra/ecs-parity/compose.ecs-parity.yaml. Se niega a ejecutarse si el endpoint de KMS no es
 * explícito y local: nunca habla con AWS.
 */
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';

const endpoint = process.env.AWS_ENDPOINT_URL_KMS ?? '';
const alias = process.env.SPECTRA_PARITY_KMS_ALIAS ?? '';

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
const host = hostnameOf(endpoint);
if (!/^http:\/\//.test(endpoint) || /amazonaws\.com$/i.test(host) || host === '') {
  console.error(
    JSON.stringify({
      fatal: true,
      reason: 'AWS_ENDPOINT_URL_KMS debe ser un emulador local http://',
    }),
  );
  process.exit(2);
}
if (!/^alias\/spectra-parity-[a-z0-9-]+$/.test(alias)) {
  console.error(
    JSON.stringify({
      fatal: true,
      reason: 'SPECTRA_PARITY_KMS_ALIAS debe ser alias/spectra-parity-*',
    }),
  );
  process.exit(2);
}

const kms = new KMSClient({ endpoint });

async function existingKeyArn() {
  try {
    const { KeyMetadata } = await kms.send(new DescribeKeyCommand({ KeyId: alias }));
    return KeyMetadata?.Arn ?? null;
  } catch (error) {
    if (error?.name === 'NotFoundException') return null;
    throw error;
  }
}

async function main() {
  let keyArn = await existingKeyArn();
  const created = keyArn === null;
  if (created) {
    const { KeyMetadata } = await kms.send(
      new CreateKeyCommand({
        KeySpec: 'ECC_NIST_P256',
        KeyUsage: 'SIGN_VERIFY',
        Description: 'PR-7A paridad ECS: firma de JWT (emulador local)',
      }),
    );
    keyArn = KeyMetadata.Arn;
    await kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: KeyMetadata.KeyId }));
  }

  const { PublicKey, KeySpec, KeyUsage, SigningAlgorithms } = await kms.send(
    new GetPublicKeyCommand({ KeyId: keyArn }),
  );
  const base64 = Buffer.from(PublicKey).toString('base64');
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;

  console.log(
    JSON.stringify({
      keyArn,
      alias,
      created,
      keySpec: KeySpec,
      keyUsage: KeyUsage,
      signingAlgorithms: SigningAlgorithms,
      publicKeyPem,
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      fatal: true,
      name: error?.name ?? null,
      message: String(error?.message ?? error),
    }),
  );
  process.exitCode = 1;
});
