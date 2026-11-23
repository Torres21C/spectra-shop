output "address" {
  description = "Nombre DNS privado de la instancia (no es secreto)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Puerto de PostgreSQL."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Nombre de la base."
  value       = aws_db_instance.this.db_name
}

output "identifier" {
  description = "Identificador de la instancia."
  value       = aws_db_instance.this.identifier
}

output "master_secret_arn" {
  description = "ARN del secreto del maestro gestionado por RDS (claves username y password)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "skip_final_snapshot" {
  description = "Confirma la política efectiva de snapshot final sin exponer datos."
  value       = aws_db_instance.this.skip_final_snapshot
}
