#!/usr/bin/env bash
# Analiza las 9 imágenes OCI con Trivy (vulnerabilidades y secretos), genera un SBOM CycloneDX por imagen,
# aplica la política de vulnerabilidades (security/image-vulnerability-exceptions.json) y comprueba que las
# imágenes runtime no contienen dependencias de desarrollo. Sin credenciales AWS.
# Uso: scripts/ecr/scan-images.sh <directorio_de_build>
set -euo pipefail

REL=${1:?uso: scan-images.sh <directorio_de_build>}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
TOOL="python3 -I scripts/ecr/release_tool.py"
[ -f "$REL/images.json" ] || { echo "FAIL falta $REL/images.json (ejecutar antes build-images.sh)" >&2; exit 1; }

CACHE=$(mktemp -d)
trap 'rm -rf "$CACHE"' EXIT
mkdir -p "$REL/scans" "$REL/sbom"

# Base de datos de vulnerabilidades: se descarga una vez y se registra su versión en el resultado.
trivy image --cache-dir "$CACHE" --download-db-only --quiet
trivy version --cache-dir "$CACHE" --format json > "$REL/scans/trivy-version.json"

while IFS=$'\t' read -r name _repository _kind _context _dockerfile _target _suffix archive; do
  echo "== $name"
  # Trivy lee un directorio con el layout OCI (no un .tar OCI): se extrae el mismo archivo cuyos blobs ya
  # verificó build-images.sh; lo que se publica sigue siendo el .tar.
  layout="$CACHE/layout/$name"
  mkdir -p "$layout"
  tar -xf "$REL/$archive" -C "$layout"
  trivy image --cache-dir "$CACHE" --skip-db-update --quiet --input "$layout" \
    --scanners vuln,secret --format json --output "$REL/scans/$name.trivy.json"
  trivy image --cache-dir "$CACHE" --skip-db-update --quiet --input "$layout" \
    --format cyclonedx --output "$REL/sbom/$name.cdx.json"
  rm -rf "$layout"
done < <($TOOL images)

$TOOL vuln-policy "$REL" --exceptions security/image-vulnerability-exceptions.json
$TOOL runtime-contents "$REL" --lockfile package-lock.json
