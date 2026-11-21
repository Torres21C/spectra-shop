#!/usr/bin/env sh
# Validación estática del Terraform de SPECTRA Shop (PR-5). NO usa credenciales AWS ni crea recursos:
#   - terraform init -backend=false (descarga proveedores), validate y test con proveedores simulados (plan);
#   - TFLint (ruleset integrado), Checkov y Trivy (misconfiguración y secretos);
#   - comprobaciones de exposición pública y de patrones prohibidos.
# Uso: infra/terraform/scripts/static-checks.sh   (desde cualquier directorio)
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

fail=0
step() { printf '\n== %s\n' "$1"; }
check() { # descripción, comando (debe devolver 0 si NO hay coincidencias prohibidas)
  if eval "$2"; then printf 'OK   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; fail=1; fi
}

step "terraform fmt -check -recursive"
terraform fmt -check -recursive

for dir in environments/lab bootstrap; do
  step "terraform init -backend=false / validate ($dir)"
  terraform -chdir="$dir" init -backend=false -input=false -no-color >/dev/null
  terraform -chdir="$dir" validate -no-color
done

step "terraform test (proveedores simulados, solo plan)"
terraform -chdir=environments/lab test -no-color

step "TFLint"
for dir in environments/lab bootstrap modules/*; do
  tflint --chdir="$dir" --config="$ROOT/.tflint.hcl" --format=compact
done
echo "TFLint sin hallazgos"

step "Checkov"
checkov -d . --framework terraform --quiet --compact --skip-download -o cli

step "Trivy (misconfiguración y secretos)"
trivy config --quiet --ignorefile .trivyignore.yaml --exit-code 1 .
trivy fs --quiet --scanners secret --exit-code 1 .

step "Rutas de CloudFront y del ALB frente a los controladores reales"
python3 -I scripts/verify-routes.py

step "Exposición pública y patrones prohibidos"
TF_FILES=$(find modules environments bootstrap -name '*.tf' -not -path '*/.terraform/*' | tr '\n' ' ')
# Líneas de código sin comentarios.
code() { grep -hv '^[[:space:]]*#' $TF_FILES; }
check "sin rutas (aws_route, route {}, NAT) en las tablas de rutas" "! code | grep -Eq 'resource \"aws_route\"|^[[:space:]]+route[[:space:]]*\\{|aws_nat_gateway|gateway_id[[:space:]]*='"
check "sin 0.0.0.0/0 ni ::/0" "! code | grep -Eq '0\\.0\\.0\\.0/0|::/0'"
check "sin IP públicas en subredes ni tareas" "! code | grep -Eq 'map_public_ip_on_launch[[:space:]]*=[[:space:]]*true|assign_public_ip[[:space:]]*=[[:space:]]*true|associate_public_ip'"
check "RDS no accesible públicamente" "code | grep -Eq 'publicly_accessible[[:space:]]*=[[:space:]]*false' && ! code | grep -Eq 'publicly_accessible[[:space:]]*=[[:space:]]*true'"
check "ALB interno" "code | grep -Eq 'internal[[:space:]]*=[[:space:]]*true'"
check "sin local-exec, null_resource ni terraform_data" "! code | grep -Eq 'local-exec|null_resource|terraform_data'"
check "secretos solo por atributos write-only (sin secret_string, master_password ni contraseñas literales)" "! code | grep -Eq '^[[:space:]]*(secret_string|master_password)[[:space:]]*=|(password|token)[[:space:]]*=[[:space:]]*\"'"
check "sin credenciales estáticas de AWS" "! grep -REq 'AKIA[0-9A-Z]{16}|aws_secret_access_key|access_key[[:space:]]*=' $TF_FILES"
check "sin permisos administrativos (Action \"*\" o AdministratorAccess)" "! code | grep -Eq 'AdministratorAccess|actions[[:space:]]*=[[:space:]]*\\[\"\\*\"\\]|\"iam:\\*\"'"
check "sin ECS Exec" "! code | grep -Eq 'enable_execute_command[[:space:]]*=[[:space:]]*true'"
check "sin state, planes ni tfvars reales en el árbol" "! find . -path ./environments/lab/.terraform -prune -o -path ./bootstrap/.terraform -prune -o \\( -name '*.tfstate*' -o -name '*.tfplan' -o -name 'terraform.tfvars' -o -name 'backend.hcl' \\) -print | grep -q ."

[ "$fail" -eq 0 ] && printf '\nTodas las validaciones estáticas superadas.\n' || { printf '\nHay validaciones fallidas.\n'; exit 1; }
