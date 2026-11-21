# Estado remoto en S3 (configuración parcial). Los valores reales van en un archivo `backend.hcl` NO
# versionado (plantilla: backend.hcl.example) y se pasan con `terraform init -backend-config=backend.hcl`.
# El bucket lo crea por separado `infra/terraform/bootstrap` (no se aplica en PR-5).
# Bloqueo nativo de S3 (`use_lockfile`, Terraform >= 1.10): sin tabla DynamoDB.
terraform {
  backend "s3" {}
}
