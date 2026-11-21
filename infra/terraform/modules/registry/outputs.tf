output "repository_urls" {
  description = "URL de cada repositorio."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

output "repository_arns" {
  description = "ARN de cada repositorio."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.arn }
}
