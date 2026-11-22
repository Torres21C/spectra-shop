output "role_arn" {
  description = "ARN del rol publicador (null si está desactivado). Se configura como variable del GitHub Environment, no como secreto."
  value       = var.enabled ? aws_iam_role.publisher[0].arn : null
}

output "oidc_provider_arn" {
  description = "ARN del proveedor OIDC usado (creado aquí o existente leído por URL); null si está desactivado."
  value       = local.oidc_provider_arn
}

output "oidc_subject" {
  description = "Claim sub exacto que acepta la política de confianza."
  value       = local.oidc_subject
}

output "oidc_provider_managed" {
  description = "true si este módulo crea y administra el proveedor OIDC; false si usa el existente de la cuenta o está desactivado."
  value       = var.enabled && var.create_oidc_provider
}

output "publish_policy_json" {
  description = "Política de permisos del rol (JSON). Sin secretos; la usan las pruebas de la raíz publisher."
  value       = var.enabled ? local.publish_policy : null
}
