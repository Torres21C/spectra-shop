# Infraestructura de PUBLICACIÓN de imágenes de SPECTRA Shop (PR-6.2; ADR-AWS-06, D-AWS-06-17 a D-AWS-06-20).
#
# Raíz independiente de environments/lab: crea SOLO los 5 repositorios ECR y, con enable_ecr_publisher = true,
# el rol OIDC publicador de GitHub Actions (y el proveedor OIDC si la cuenta no lo tiene). No crea red, ECS,
# RDS, ALB, CloudFront, WAF, Secrets Manager ni CloudWatch: lo comprueba scripts/check_state_ownership.py.
#
#   bootstrap (state S3) ─▶ publisher: registry (5 ECR, aws/ecr) ─repository_arns─▶ github_oidc_publisher
#                                          │ (por nombre, sin compartir state)
#                           environments/lab: data "aws_ecr_repository" ×5 ─▶ ecs
#
# Orden: bootstrap → publisher → lab. lab no puede planificarse sin estos repositorios (falla el data source).

locals {
  name_prefix = "spectra-${var.environment}"

  # Los 5 repositorios que consumen las 9 imágenes (scripts/ecr/release_tool.py) y las task definitions de lab.
  repositories = ["identity-service", "catalog-service", "commerce-service", "audit-service", "db-ops"]
}

module "registry" {
  source = "../modules/registry"

  repository_prefix = "spectra"
  repositories      = local.repositories
  # kms_key_arn sin indicar: clave administrada por AWS aws/ecr (D2).
  force_delete = var.ecr_force_delete
  keep_images  = var.ecr_keep_images
}

# Rol publicador de imágenes para GitHub Actions (OIDC). Desactivado por defecto (enable_ecr_publisher).
module "ecr_publisher" {
  source = "../modules/github_oidc_publisher"

  enabled              = var.enable_ecr_publisher
  name_prefix          = local.name_prefix
  create_oidc_provider = var.create_github_oidc_provider
  oidc_subject_prefix  = var.github_oidc_subject_prefix
  github_environment   = var.github_publish_environment
  repository_arns      = module.registry.repository_arns
}
