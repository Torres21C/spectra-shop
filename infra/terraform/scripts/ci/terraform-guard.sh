#!/usr/bin/env sh
# Envoltorio de Terraform para la CI de IaC (`.github/workflows/iac.yml`). Se instala como `terraform` en el
# PATH del job y delega en el binario real (TERRAFORM_REAL). Solo deja pasar subcomandos que no crean
# infraestructura ni leen o escriben estado remoto:
#   fmt, validate, test, version e init con -backend=false.
# Cualquier otro subcomando termina con código 97 sin invocar a Terraform. Prueba: ci/test-terraform-guard.sh.
set -eu

real=${TERRAFORM_REAL:?terraform-guard: TERRAFORM_REAL no está definido}

sub=""
for arg in "$@"; do
  case $arg in
    -chdir=*) continue ;;
    *) sub=$arg; break ;;
  esac
done

deny() {
  printf 'terraform-guard: %s\n' "$1" >&2
  exit 97
}

case $sub in
  fmt | validate | test | version | -version | --version | -v) ;;
  init)
    case " $* " in
      *" -backend=false "*) ;;
      *) deny "init solo se permite con -backend=false" ;;
    esac
    ;;
  *) deny "subcomando no permitido en la CI de IaC: '${sub:-<vacío>}'" ;;
esac

exec "$real" "$@"
