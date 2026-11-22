output "state_bucket" {
  description = "Bucket del state (backend.hcl: bucket)."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "Clave KMS del state (backend.hcl: kms_key_id)."
  value       = aws_kms_key.state.arn
}

output "state_audit_bucket" {
  description = "Bucket con los registros de CloudTrail de los accesos al state (R-PR5-26)."
  value       = aws_s3_bucket.audit.bucket
}

output "state_audit_trail_arn" {
  description = "Trail que registra los eventos de datos del bucket del state."
  value       = aws_cloudtrail.state_audit.arn
}

output "account_budget_name" {
  description = "Presupuesto mensual de la cuenta (aviso por correo; no limita el gasto)."
  value       = aws_budgets_budget.account.name
}
