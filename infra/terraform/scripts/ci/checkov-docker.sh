#!/usr/bin/env sh
# Envoltorio de Checkov para la CI de IaC. Checkov no publica binarios; se ejecuta la imagen oficial fijada por
# digest (CHECKOV_IMAGE), sin red (--skip-download no la necesita), sin privilegios de root y montando el
# espacio de trabajo en la misma ruta para que las rutas relativas y absolutas coincidan con las locales.
set -eu
image=${CHECKOV_IMAGE:?checkov-docker: CHECKOV_IMAGE no está definido}
workspace=${GITHUB_WORKSPACE:?checkov-docker: GITHUB_WORKSPACE no está definido}
exec docker run --rm --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$workspace:$workspace:ro" -w "$PWD" --entrypoint checkov "$image" "$@"
