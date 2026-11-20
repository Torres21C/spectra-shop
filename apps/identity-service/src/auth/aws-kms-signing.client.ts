import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { KmsPublicKey, KmsSigningClient } from './kms-es256.adapter.js';

/**
 * Cliente real de AWS KMS. Región y credenciales salen de la cadena estándar del SDK (en ECS: la variable
 * AWS_REGION y el rol de la tarea). Requiere `kms:GetPublicKey` y `kms:Sign` sobre la clave, y el VPC
 * endpoint de KMS si la VPC no tiene salida a Internet.
 */
export class AwsKmsSigningClient implements KmsSigningClient {
  private readonly client = new KMSClient({
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 },
  });

  async getPublicKey(keyId: string): Promise<KmsPublicKey> {
    const output = await this.client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!output.PublicKey) throw new Error('KMS no devolvió la clave pública');
    return {
      spkiDer: output.PublicKey,
      keySpec: output.KeySpec,
      keyUsage: output.KeyUsage,
      signingAlgorithms: output.SigningAlgorithms ?? [],
    };
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const output = await this.client.send(
      new SignCommand({
        KeyId: keyId,
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!output.Signature) throw new Error('KMS no devolvió la firma');
    return output.Signature;
  }
}
