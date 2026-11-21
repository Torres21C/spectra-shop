#!/usr/bin/env bash
# Job publish: copia a ECR exactamente los archivos OCI analizados (skopeo --preserve-digests), sin sobrescribir
# etiquetas inmutables, y verifica en ECR el digest de cada imagen. Requiere credenciales OIDC ya obtenidas.
# Uso: scripts/ecr/publish-images.sh <directorio_release>
#
# Orden seguro: 1) identidad = rol publicador; 2) comprobar las 9 etiquetas antes de copiar nada (si alguna
# existe con otro digest, no se publica ninguna); 3) copiar las pendientes; 4) verificar los 9 digest en ECR;
# 5) manifiesto de publicación. Las imágenes ya presentes con el mismo digest se dan por publicadas
# (idempotente). Sin operaciones de ECS, migraciones ni Terraform.
set -euo pipefail

REL=${1:?uso: publish-images.sh <directorio_release>}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
TOOL="python3 -I scripts/ecr/release_tool.py"
: "${AWS_REGION:?}" "${AWS_ACCOUNT_ID:?}" "${COMMIT_SHA:?}"
command -v skopeo >/dev/null || { echo "FAIL skopeo no está disponible" >&2; exit 1; }
command -v aws >/dev/null || { echo "FAIL AWS CLI no está disponible" >&2; exit 1; }

# 1) La identidad debe ser el rol publicador.
caller=$(aws sts get-caller-identity --query Arn --output text </dev/null)
[[ "$caller" == "arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/spectra-lab-ecr-publisher/"* ]] || {
  echo "FAIL identidad inesperada: $caller" >&2; exit 1; }

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
WORK=$(mktemp -d)
AUTH="$WORK/auth.json"
trap 'skopeo logout --authfile "$AUTH" --all >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
aws ecr get-login-password --region "$AWS_REGION" | skopeo login --authfile "$AUTH" --username AWS --password-stdin "$REGISTRY" >/dev/null

expected_digest() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(next(e["manifest_digest"] for e in d["images"] if e["name"]==sys.argv[2]))' "$REL/images.json" "$1"; }
remote_digest() { # repositorio etiqueta -> digest | NOT_FOUND ; cualquier otro error termina el script
  local out
  if out=$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$1" --image-ids "imageTag=$2" \
      --query 'imageDetails[0].imageDigest' --output text 2>"$WORK/err"); then
    echo "$out"
  elif grep -q 'ImageNotFoundException' "$WORK/err"; then
    echo NOT_FOUND
  else
    echo "FAIL no se pudo consultar $1:$2: $(cat "$WORK/err")" >&2
    return 1
  fi
}

mkdir -p "$WORK/state"
tag_of() { if [ "$1" = "-" ]; then echo "$COMMIT_SHA"; else echo "$COMMIT_SHA$1"; fi; }

# 2) Comprobar las 9 etiquetas antes de copiar nada.
mismatch=0
while IFS=$'\t' read -r name repository _kind _context _dockerfile _target suffix _archive; do
  tag=$(tag_of "$suffix")
  want=$(expected_digest "$name")
  have=$(remote_digest "$repository" "$tag" </dev/null)
  if [ "$have" = "NOT_FOUND" ]; then
    echo pending > "$WORK/state/$name"
  elif [ "$have" = "$want" ]; then
    echo already-present > "$WORK/state/$name"
    echo "== $repository:$tag ya publicada con el mismo digest"
  else
    echo "FAIL $repository:$tag ya existe con otro digest ($have ≠ $want): no se sobrescribe" >&2
    mismatch=1
  fi
done < <($TOOL images)
[ "$mismatch" -eq 0 ] || { echo "FAIL publicación abortada antes de copiar ninguna imagen" >&2; exit 1; }

# 3) Copiar las pendientes y 4) verificar los 9 digest en ECR.
echo '{}' > "$WORK/states.json"
while IFS=$'\t' read -r name repository _kind _context _dockerfile _target suffix archive; do
  tag=$(tag_of "$suffix")
  state=$(cat "$WORK/state/$name")
  if [ "$state" = "pending" ]; then
    echo "== publicando $repository:$tag"
    skopeo copy --authfile "$AUTH" --preserve-digests --retry-times 3 \
      "oci-archive:$REL/$archive" "docker://$REGISTRY/$repository:$tag" </dev/null
    state=published
  fi
  want=$(expected_digest "$name")
  have=$(remote_digest "$repository" "$tag" </dev/null)
  [ "$have" = "$want" ] || { echo "FAIL $repository:$tag tiene en ECR el digest $have, se esperaba $want" >&2; exit 1; }
  python3 -I -c 'import json,sys;p=sys.argv[1];d=json.load(open(p));d[sys.argv[2]]={"digest":sys.argv[3],"publication":sys.argv[4]};json.dump(d,open(p,"w"))' \
    "$WORK/states.json" "$name" "$have" "$state"
done < <($TOOL images)

# 5) Manifiesto de publicación.
$TOOL manifest "$REL" --states "$WORK/states.json" --registry "$REGISTRY"
$TOOL published-summary "$REL" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
