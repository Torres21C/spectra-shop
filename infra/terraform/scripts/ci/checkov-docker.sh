#!/usr/bin/env sh
# Checkov 3.4.6 de la imagen oficial, fijada por digest. Lo usan la CI (.github/workflows/iac.yml) y
# static-checks.sh en local cuando el Checkov instalado está incompleto (la fórmula de Homebrew 3.4.6 no trae
# las comprobaciones de grafo CKV2_* ni las CKV_AWS_* definidas en JSON).
#
# Checkov no publica binarios. La imagen se ejecuta sin red (--skip-download no la necesita), con el sistema de
# archivos de solo lectura, sin root y sin montar el repositorio: el directorio actual se copia a un tmpfs del
# contenedor mediante tar. Hay que invocarlo desde el directorio que se analiza (rutas relativas, p. ej. -d .).
set -eu

CHECKOV_IMAGE=${CHECKOV_IMAGE:-bridgecrew/checkov@sha256:b4b7e9d419ddb9ae7a257678ee39cb5d9e5569f604723297dd9cec7fd4571bff}

# COPYFILE_DISABLE y --exclude '._*': sin archivos AppleDouble de macOS, que Checkov intentaría analizar.
COPYFILE_DISABLE=1 tar -cf - --exclude .terraform --exclude '._*' . |
  docker run -i --rm --network none --read-only --tmpfs /tmp:exec --user "$(id -u):$(id -g)" -e HOME=/tmp \
    --entrypoint sh "$CHECKOV_IMAGE" -c 'mkdir /tmp/w && tar -xf - -C /tmp/w && cd /tmp/w && exec checkov "$@"' checkov "$@"
