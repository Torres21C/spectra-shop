output "db_role_secret_arns" {
  description = "ARN del secreto de cada rol DT-09 (<servicio>-<migrator|app>)."
  value       = { for name, s in aws_secretsmanager_secret.db_role : name => s.arn }
}

output "internal_token_secret_arn" {
  description = "ARN del token interno compartido."
  value       = aws_secretsmanager_secret.token["internal-token"].arn
}

output "inventory_token_secret_arn" {
  description = "ARN del token de inventario (Commerce → Catalog)."
  value       = aws_secretsmanager_secret.token["inventory-token"].arn
}

output "synthetic_admin_secret_arn" {
  description = "ARN del secreto del ADMIN sintético, o null."
  value       = one(aws_secretsmanager_secret.synthetic_admin[*].arn)
}

output "secret_names" {
  description = "Nombres de los secretos creados (sin valores)."
  value = concat(
    [for s in aws_secretsmanager_secret.db_role : s.name],
    [for s in aws_secretsmanager_secret.token : s.name],
    aws_secretsmanager_secret.synthetic_admin[*].name,
  )
}
