# Estado remoto propio en el bucket de infra/terraform/bootstrap (configuración parcial), con una clave
# distinta de la de lab: cada raíz administra sus recursos en su propio state (PR-6.2, D-AWS-06-17).
# Los valores reales van en un `backend.hcl` NO versionado (plantilla: backend.hcl.example):
#   terraform init -backend-config=backend.hcl
# Bloqueo nativo de S3 (`use_lockfile`): sin tabla DynamoDB.
terraform {
  backend "s3" {}
}
