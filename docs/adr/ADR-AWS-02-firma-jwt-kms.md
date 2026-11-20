# ADR-AWS-02 — Firma de los JWT de acceso con AWS KMS (AD-08)

- **Estado:** propuesta (pendiente de aprobación del propietario). Implementada en la rama local `feature/aws-pr2-jwt-kms`. El propietario eligió KMS para AWS el 2026-11-20.
- **Fecha:** 2026-11-20
- **Hallazgos:** AWS-01 y AWS-32 del [diagnóstico AWS](../operacion-y-aws/03-diagnostico-aws.md). Implementa la decisión AD-08 de la arquitectura de la Fase 2.

## Contexto

Identity solo tenía `DevelopmentEs256Adapter`, que lee las claves PEM de archivos. Los consumidores (Catalog, Commerce y Audit) leían la clave pública también de un archivo. ECS no monta secretos como archivos, y AD-08 exige que la clave privada nunca salga de KMS. El puerto `JwtCryptoPort` ya preveía un adaptador KMS.

## Decisiones

1. **D-AWS-02-01. Adaptador `KmsEs256Adapter`.** Se activa con `IDENTITY_JWT_SIGNER=kms` e `IDENTITY_KMS_KEY_ID` (ARN, id o alias). El valor por defecto `file` conserva el comportamiento local y el de las pruebas.
   - Al arrancar obtiene la clave pública con `GetPublicKey` y exige `ECC_NIST_P256`, `SIGN_VERIFY` y `ECDSA_SHA_256`.
   - Calcula el `kid` como huella JWK (RFC 7638).
   - Hace una **autoprueba de firma**: falla al arrancar si el rol de la tarea no puede firmar o la firma no verifica.
2. **D-AWS-02-02. Firma con `MessageType: RAW`.** KMS calcula el SHA-256 del texto `header.payload` (≈ 350 bytes, por debajo del límite de 4096) y devuelve la firma en DER. `derToJoseSignature` la convierte al formato `R‖S` de 64 bytes que exige JWS ES256. Las pruebas usan 2000 firmas reales, que incluyen componentes cortos y componentes con el bit alto activo, además de DER malformado. Los claims (`sub`, `sid`, `role`, `jti`, `iss`, `aud`, `iat`, `exp`) son los mismos que en el adaptador de desarrollo.
3. **D-AWS-02-03. Verificación local.** Identity y los consumidores verifican con la clave pública en memoria. KMS solo interviene en el login y el refresh (cuota `Sign`), nunca por petición.
4. **D-AWS-02-04. Clave pública de los consumidores por variable.** Catalog, Commerce y Audit aceptan `IDENTITY_PUBLIC_KEY_PEM` (la clave pública de KMS en PEM; no es un secreto) o `IDENTITY_PUBLIC_KEY_PATH`, exactamente una. Así no necesitan permisos de KMS ni el SDK. Commerce lo valida al arrancar, como antes.
5. **D-AWS-02-05. Dependencia.** `@aws-sdk/client-kms` fijada en la versión exacta `3.1163.0` (publicada el 2026-11-05, con al menos dos semanas de antigüedad), solo en Identity.

## Operación en AWS

```bash
# Clave (una vez): asimétrica de firma P-256.
aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --description "SPECTRA JWT ES256"
aws kms create-alias --alias-name alias/spectra-jwt --target-key-id <key-id>
# PEM para IDENTITY_PUBLIC_KEY_PEM de Catalog, Commerce y Audit:
aws kms get-public-key --key-id alias/spectra-jwt --query PublicKey --output text \
  | base64 --decode | openssl pkey -pubin -inform DER -outform PEM
```

- Rol de tarea de Identity: `kms:Sign` y `kms:GetPublicKey` sobre la clave, con la condición `kms:SigningAlgorithm = ECDSA_SHA_256`. Los consumidores no necesitan permisos de KMS.
- Variables de Identity: `IDENTITY_JWT_SIGNER=kms`, `IDENTITY_KMS_KEY_ID=alias/spectra-jwt` y `AWS_REGION`. Sin VPC con salida a Internet, hace falta el **VPC endpoint `kms`** (≈ 7 USD/mes en 1 AZ, por verificar).
- **Rotación:** KMS no rota automáticamente las claves asimétricas. Para rotar: crear la clave nueva, publicar su PEM en los consumidores, cambiar `IDENTITY_KMS_KEY_ID` y redesplegar. Los JWT emitidos con la clave anterior caducan en 15 minutos; los consumidores verifican con una sola clave, así que durante el cambio puede haber 401 que obliguen a refrescar la sesión.

## Consecuencias

- El modo `kms` **no se puede probar de extremo a extremo sin AWS**. El adaptador se prueba con un KMS simulado que firma con una clave P-256 real, y `AwsKmsSigningClient` es una capa delgada sobre el SDK. La validación real queda para el laboratorio (prueba P8 del plan).
- La imagen de Identity incluye el SDK de KMS (más dependencias de producción).
- `IDENTITY_ALLOW_EPHEMERAL_KEYS` y `IDENTITY_PRIVATE_KEY_PATH` no se usan en modo `kms`.
