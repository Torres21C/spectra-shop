output "cluster_name" {
  description = "Nombre del clúster."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ARN del clúster."
  value       = aws_ecs_cluster.this.arn
}

output "service_names" {
  description = "Servicios ECS."
  value       = [for s in aws_ecs_service.this : s.name]
}

output "ops_task_definition_families" {
  description = "Familias de las tareas run-task (provision, migrate y finalize)."
  value       = { for name, td in aws_ecs_task_definition.ops : name => td.family }
}

output "service_task_definition_arns" {
  description = "Revisión vigente de cada servicio."
  value       = { for name, td in aws_ecs_task_definition.service : name => td.arn }
}

output "execution_role_arns" {
  description = "Rol de ejecución de cada carga de trabajo."
  value       = { for name, role in aws_iam_role.execution : name => role.arn }
}

output "identity_task_role_arn" {
  description = "Rol de tarea de identity-service."
  value       = aws_iam_role.identity_task.arn
}

output "service_discovery_namespace_id" {
  description = "Espacio de Cloud Map."
  value       = aws_service_discovery_private_dns_namespace.this.id
}
