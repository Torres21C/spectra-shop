#!/usr/bin/env bash
# Construye las 9 imágenes de un commit para linux/amd64 como archivos OCI, sin credenciales AWS ni registro.
# Uso: scripts/ecr/build-images.sh <directorio_salida>    (COMMIT_SHA opcional; por defecto HEAD)
#
# - BuildKit fijado por digest (builder docker-container propio, eliminado al terminar).
# - Sin atestaciones (--provenance=false --sbom=false): un único manifiesto OCI por imagen, el mismo que se
#   analiza y se publica. El SBOM se genera aparte con Trivy.
# - SOURCE_DATE_EPOCH = fecha del commit y rewrite-timestamp=true: reproducibilidad razonable.
# - Etiqueta org.opencontainers.image.revision = SHA: impide mezclar imágenes de commits distintos.
set -euo pipefail

OUT=${1:?uso: build-images.sh <directorio_salida>}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
TOOL="python3 -I scripts/ecr/release_tool.py"

SHA=${COMMIT_SHA:-$(git rev-parse HEAD)}
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL SHA inválido: $SHA" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$SHA" ] || { echo "FAIL el árbol de trabajo no está en $SHA" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "FAIL hay cambios sin commit: la imagen no correspondería a $SHA" >&2; exit 1; }

BUILDKIT_IMAGE=$($TOOL buildkit)
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct "$SHA")
export SOURCE_DATE_EPOCH
BUILDER="spectra-ecr-${SHA:0:12}-$$"

mkdir -p "$OUT/images"
docker buildx create --name "$BUILDER" --driver docker-container --driver-opt "image=$BUILDKIT_IMAGE" --bootstrap >/dev/null
trap 'docker buildx rm --force "$BUILDER" >/dev/null 2>&1 || true' EXIT

while IFS=$'\t' read -r name repository kind context dockerfile target suffix archive; do
  echo "== $name ($repository, $kind)"
  args=(
    --builder "$BUILDER"
    --platform linux/amd64
    --file "$dockerfile"
    --provenance=false
    --sbom=false
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
    --label "org.opencontainers.image.revision=$SHA"
    --label "org.opencontainers.image.source=https://github.com/Torres21C/spectra-shop"
    --label "org.opencontainers.image.title=$name"
    --output "type=oci,dest=$OUT/$archive,rewrite-timestamp=true"
  )
  [ "$target" != "-" ] && args+=(--target "$target")
  docker buildx build "${args[@]}" "$context"
done < <($TOOL images)

$TOOL describe "$OUT" --sha "$SHA"
