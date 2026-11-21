#!/usr/bin/env sh
# Validación estática del Terraform de SPECTRA Shop (PR-5). NO usa credenciales AWS ni crea recursos:
#   - terraform init -backend=false (descarga proveedores), validate y test con proveedores simulados (plan);
#   - TFLint (ruleset integrado), Checkov y Trivy (misconfiguración y secretos);
#   - comprobaciones de exposición pública y de patrones prohibidos;
#   - garantías de la CI: pruebas solo con plan y proveedores simulados, envoltorio de Terraform de la CI
#     (scripts/ci/terraform-guard.sh) que bloquea apply/destroy, y política de workflows: sin credenciales AWS
#     estáticas ni despliegues, y OIDC solo en el job publish de ecr-publish.yml (PR-6, ADR-AWS-06);
#   - pruebas del pipeline de publicación en ECR (scripts/tests, sin AWS).
# La CI (.github/workflows/iac.yml) ejecuta este mismo script con las mismas versiones de las herramientas.
# Uso: infra/terraform/scripts/static-checks.sh   (desde cualquier directorio)
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$ROOT/../.." && pwd)
cd "$ROOT"
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

fail=0
step() { printf '\n== %s\n' "$1"; }
tests_only_plan() { # cada bloque run declara command = plan y cada archivo simula el proveedor AWS
  for f in $TEST_FILES; do
    runs=$(grep -cE '^[[:space:]]*run[[:space:]]+"' "$f" || true)
    plans=$(grep -cE '^[[:space:]]*command[[:space:]]*=[[:space:]]*plan[[:space:]]*$' "$f" || true)
    [ "$runs" -gt 0 ] && [ "$runs" -eq "$plans" ] || return 1
    grep -Eq '^[[:space:]]*mock_provider[[:space:]]+"aws"' "$f" || return 1
    ! grep -Eq '^[[:space:]]*(provider[[:space:]]+"|command[[:space:]]*=[[:space:]]*apply)' "$f" || return 1
  done
}
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
# Se exige un Checkov completo: la fórmula de Homebrew 3.4.6 no incluye las comprobaciones de grafo y daba
# resultados verdes incompletos. Si el instalado no las trae, se usa la imagen fijada de la CI (Docker).
checkov_complete() { [ "$($CHECKOV --list --framework terraform 2>/dev/null | grep -c 'CKV2_AWS_')" -ge 50 ]; }
CHECKOV=${CHECKOV:-checkov}
if ! checkov_complete; then
  echo "Checkov '$CHECKOV' no incluye las comprobaciones de grafo; se usa la imagen fijada (scripts/ci/checkov-docker.sh)."
  CHECKOV="sh $ROOT/scripts/ci/checkov-docker.sh"
  checkov_complete || { echo "FAIL Checkov completo no disponible (se necesita Docker o un Checkov con CKV2_*)."; exit 1; }
fi
$CHECKOV --version
# Un archivo que Checkov no puede analizar deja recursos sin evaluar: también es un fallo.
CHECKOV_OUT=$(mktemp)
checkov_rc=0
$CHECKOV -d . --framework terraform --quiet --compact --skip-download -o cli > "$CHECKOV_OUT" 2>&1 || checkov_rc=$?
cat "$CHECKOV_OUT"
if grep -q 'Parsing errors' "$CHECKOV_OUT"; then echo "FAIL Checkov no pudo analizar algunos archivos"; checkov_rc=1; fi
rm -f "$CHECKOV_OUT"
[ "$checkov_rc" -eq 0 ] || exit "$checkov_rc"

step "Documento de excepciones de Checkov (justificaciones del código y sincronía)"
# Falla si una excepción no tiene justificación en el código, no está clasificada o el documento difiere.
CHECKOV_JSON=$(mktemp)
$CHECKOV -d . --framework terraform --skip-download -o json > "$CHECKOV_JSON" 2>/dev/null || true
exceptions_rc=0
python3 -I scripts/checkov-exceptions-doc.py check "$CHECKOV_JSON" docs/07-excepciones-checkov.md || exceptions_rc=$?
rm -f "$CHECKOV_JSON"
[ "$exceptions_rc" -eq 0 ] || exit "$exceptions_rc"

step "Trivy (misconfiguración y secretos)"
# Caché vacía y --skip-check-update: se usan las reglas incluidas en el binario fijado, no un paquete de
# reglas descargado en el momento, para que el resultado local y el de la CI sean reproducibles.
TRIVY_CACHE=$(mktemp -d)
trap 'rm -rf "$TRIVY_CACHE"' EXIT
trivy config --quiet --cache-dir "$TRIVY_CACHE" --skip-check-update --ignorefile .trivyignore.yaml --exit-code 1 .
trivy fs --quiet --cache-dir "$TRIVY_CACHE" --scanners secret --exit-code 1 .

step "Rutas de CloudFront y del ALB frente a los controladores reales"
python3 -I scripts/verify-routes.py

step "Envoltorio de Terraform de la CI (bloqueo de apply, destroy, plan y estado remoto)"
sh scripts/ci/test-terraform-guard.sh

step "Política de workflows de GitHub Actions (OIDC solo en el job publish de ecr-publish.yml)"
python3 -I "$REPO_ROOT/scripts/ci/verify_workflows.py" "$REPO_ROOT"

step "Pruebas del pipeline de publicación en ECR y de la política de workflows (sin AWS)"
python3 -I -m unittest discover -s "$REPO_ROOT/scripts/tests" -t "$REPO_ROOT" -p 'test_*.py'

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
TEST_FILES=$(find environments -name '*.tftest.hcl' -not -path '*/.terraform/*' | tr '\n' ' ')
check "pruebas solo con command = plan y proveedor AWS simulado" "tests_only_plan"
check "workflows sin credenciales AWS estáticas, despliegues, migraciones ni Terraform apply/destroy" "! grep -Eq 'AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|aws-access-key-id|aws-secret-access-key|secrets\\.AWS|terraform[^#]*[[:space:]](apply|destroy)([[:space:]]|$)|run-task|update-service|register-task-definition|prisma[[:space:]]+migrate' \"$REPO_ROOT\"/.github/workflows/*.yml"
check "OIDC (id-token: write, aws-actions, role-to-assume) solo en ecr-publish.yml" "! grep -lE 'id-token:[[:space:]]*write|aws-actions/|role-to-assume' \"$REPO_ROOT\"/.github/workflows/*.yml | grep -vq '/ecr-publish.yml$'"
check "sin state, planes ni tfvars reales en el árbol" "! find . -path ./environments/lab/.terraform -prune -o -path ./bootstrap/.terraform -prune -o \\( -name '*.tfstate*' -o -name '*.tfplan' -o -name 'terraform.tfvars' -o -name 'backend.hcl' \\) -print | grep -q ."

[ "$fail" -eq 0 ] && printf '\nTodas las validaciones estáticas superadas.\n' || { printf '\nHay validaciones fallidas.\n'; exit 1; }
