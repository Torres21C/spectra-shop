#!/usr/bin/env bash
# Job verify del workflow ecr-publish: el SHA debe ser código autorizado de main y haber pasado los 5 checks
# requeridos en ejecuciones push de main; con PUBLISH=true, el Environment debe existir y estar protegido.
# Solo lectura de la API de GitHub (GITHUB_TOKEN con contents/checks/actions: read). Sin AWS.
set -euo pipefail

: "${COMMIT_SHA:?falta COMMIT_SHA}" "${PUBLISH:?falta PUBLISH}" "${PUBLISH_ENVIRONMENT:?falta PUBLISH_ENVIRONMENT}"
: "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}" "${GITHUB_OUTPUT:?}"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL SHA inválido (40 hex en minúsculas)" >&2; exit 1; }
[[ "$PUBLISH" == "true" || "$PUBLISH" == "false" ]] || { echo "FAIL PUBLISH debe ser true o false" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git fetch --no-tags --quiet origin main
git rev-list --first-parent origin/main > "$WORK/first-parent.txt"
gh api "repos/$GITHUB_REPOSITORY/commits/$COMMIT_SHA/check-runs?filter=latest&per_page=100" > "$WORK/check-runs.json"
gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$COMMIT_SHA&event=push&branch=main&per_page=100" > "$WORK/runs.json"

env_args=()
if [ "$PUBLISH" = "true" ]; then
  # Un Environment inexistente se crearía sin protección al usarlo: aquí se exige que ya exista protegido.
  if gh api "repos/$GITHUB_REPOSITORY/environments/$PUBLISH_ENVIRONMENT" > "$WORK/environment.json" 2>/dev/null; then
    gh api "repos/$GITHUB_REPOSITORY/environments/$PUBLISH_ENVIRONMENT/deployment-branch-policies" > "$WORK/branch-policies.json"
    env_args=(--environment "$WORK/environment.json" --branch-policies "$WORK/branch-policies.json")
  else
    echo "FAIL el Environment $PUBLISH_ENVIRONMENT no existe o no es legible: no se publica" >&2
    exit 1
  fi
fi

python3 -I scripts/ecr/release_tool.py verify-ref --sha "$COMMIT_SHA" --ref "$GITHUB_REF" \
  --first-parent "$WORK/first-parent.txt" --check-runs "$WORK/check-runs.json" \
  --workflow-runs "$WORK/runs.json" --publish "$PUBLISH" ${env_args[@]+"${env_args[@]}"}
echo "sha=$COMMIT_SHA" >> "$GITHUB_OUTPUT"
