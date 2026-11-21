#!/usr/bin/env sh
# Comprueba que ci/terraform-guard.sh bloquea los subcomandos que podrían crear o destruir infraestructura
# o tocar estado remoto, y que deja pasar los de la validación estática. Usa un binario simulado: no ejecuta
# Terraform ni necesita red ni credenciales.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '#!/bin/sh\necho "REAL $*" >> "%s/llamadas"\n' "$TMP" > "$TMP/terraform-real"
chmod +x "$TMP/terraform-real"
export TERRAFORM_REAL="$TMP/terraform-real"

fail=0
expect() { # esperado (permitido|bloqueado), argumentos...
  want=$1
  shift
  : > "$TMP/llamadas"
  if sh "$DIR/terraform-guard.sh" "$@" 2>/dev/null; then got=permitido; else got=bloqueado; fi
  if [ "$got" = bloqueado ] && [ -s "$TMP/llamadas" ]; then got="bloqueado-pero-ejecutado"; fi
  if [ "$got" = "$want" ]; then printf 'OK   %-10s terraform %s\n' "$want" "$*"; else printf 'FAIL %-10s terraform %s (obtenido: %s)\n' "$want" "$*" "$got"; fail=1; fi
}

for args in "apply" "apply -auto-approve" "-chdir=environments/lab apply -auto-approve" "destroy" "-chdir=bootstrap destroy -auto-approve" \
  "plan" "-chdir=environments/lab plan -out=tfplan" "import aws_s3_bucket.x b" "state list" "state rm x" "refresh" "taint x" \
  "untaint x" "workspace new x" "force-unlock 1" "output" "console" "login" "show" "graph" "providers lock" "get" \
  "init" "-chdir=environments/lab init -input=false" "init -backend-config=backend.hcl" "-chdir=environments/lab" ""; do
  # shellcheck disable=SC2086
  expect bloqueado $args
done
for args in "fmt -check -recursive" "-chdir=environments/lab init -backend=false -input=false -no-color" \
  "-chdir=environments/lab validate -no-color" "-chdir=environments/lab test -no-color" "version" "-version"; do
  # shellcheck disable=SC2086
  expect permitido $args
done

[ "$fail" -eq 0 ] && echo "Envoltorio de Terraform: todos los casos correctos." || { echo "Envoltorio de Terraform: hay casos incorrectos."; exit 1; }
