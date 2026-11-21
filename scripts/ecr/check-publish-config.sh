#!/usr/bin/env bash
# Job publish, antes de pedir el token OIDC: la configuración del Environment debe estar completa y ser la
# esperada. Si falta algo, falla sin contactar con AWS.
set -euo pipefail

errors=0
err() { echo "FAIL $1" >&2; errors=1; }
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || err "la publicación solo se admite desde main"
[ "${AWS_REGION:-}" = "us-east-1" ] || err "la variable AWS_REGION del Environment debe ser us-east-1 (actual: '${AWS_REGION:-}')"
[[ "${AWS_ACCOUNT_ID:-}" =~ ^[0-9]{12}$ ]] || err "falta la variable AWS_ACCOUNT_ID del Environment (12 dígitos)"
expected="arn:aws:iam::${AWS_ACCOUNT_ID:-}:role/spectra-lab-ecr-publisher"
[ "${AWS_ECR_PUBLISHER_ROLE_ARN:-}" = "$expected" ] || err "AWS_ECR_PUBLISHER_ROLE_ARN debe ser $expected (salida ecr_publisher_role_arn de Terraform)"
[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || err "el job no tiene id-token: write (OIDC no disponible)"
[[ "${COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || err "COMMIT_SHA inválido"
[[ "${EXPECTED_DIGESTS_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || err "falta el hash de images.json del job build-scan"
[ "$errors" -eq 0 ] || exit 1
echo "OK   configuración del Environment completa (cuenta, región, rol, OIDC)"
