output "role_arn" {
  description = "ARN del rol publicador (null si está desactivado). Se configura como variable del GitHub Environment, no como secreto."
  value       = var.enabled ? aws_iam_role.publisher[0].arn : null
}

output "oidc_provider_arn" {
  description = "ARN del proveedor OIDC usado (creado o reutilizado); null si está desactivado."
  value       = local.oidc_provider_arn
}

output "oidc_subject" {
  description = "Claim sub exacto que acepta la política de confianza."
  value       = local.oidc_subject
}
