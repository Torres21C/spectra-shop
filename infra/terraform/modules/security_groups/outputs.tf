output "alb_sg_id" {
  description = "Security group del ALB."
  value       = aws_security_group.alb.id
}

output "service_sg_ids" {
  description = "Security group de cada servicio ECS."
  value       = { for name, sg in aws_security_group.service : name => sg.id }
}

output "ops_sg_id" {
  description = "Security group de las tareas run-task (provision, migrate, finalize)."
  value       = aws_security_group.ops.id
}

output "rds_sg_id" {
  description = "Security group de RDS."
  value       = aws_security_group.rds.id
}

output "endpoints_sg_id" {
  description = "Security group de los VPC interface endpoints."
  value       = aws_security_group.endpoints.id
}
