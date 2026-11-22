# Ninguna salida contiene secretos: solo nombres, URL y ARN.

output "ecr_repository_names" {
  description = "Nombres de los 5 repositorios (environments/lab los lee con data \"aws_ecr_repository\")."
  value       = { for name, url in module.registry.repository_urls : name => "spectra/${name}" }
}

output "ecr_repository_urls" {
  description = "URL de los repositorios (destino de skopeo en scripts/ecr/publish-images.sh)."
  value       = module.registry.repository_urls
}

output "ecr_repository_arns" {
  description = "ARN de los repositorios (únicos recursos sobre los que publica el rol)."
  value       = module.registry.repository_arns
}

output "ecr_publisher_role_arn" {
  description = "Rol OIDC publicador (null si enable_ecr_publisher = false). Va en la variable AWS_ECR_PUBLISHER_ROLE_ARN del Environment ecr-publish-lab."
  value       = module.ecr_publisher.role_arn
}

output "ecr_publisher_oidc_subject" {
  description = "Claim sub exacto aceptado por el rol publicador."
  value       = module.ecr_publisher.oidc_subject
}

output "github_oidc_provider_arn" {
  description = "Proveedor OIDC de GitHub usado (creado aquí o existente); null si el publicador está desactivado."
  value       = module.ecr_publisher.oidc_provider_arn
}

output "github_oidc_provider_managed_here" {
  description = "true si esta raíz crea y administra el proveedor OIDC de la cuenta (único por URL)."
  value       = module.ecr_publisher.oidc_provider_managed
}
