# Ninguna salida contiene secretos: solo identificadores, nombres y ARN.

output "account_id" {
  description = "Cuenta donde se aplicó (enmascararla en las evidencias)."
  value       = local.account_id
}

output "public_origin" {
  description = "Origen público https://<dominio>: VITE_*_API_URL del build de la Web (PR-6) y CORS_ORIGINS."
  value       = module.edge.public_origin
}

output "cloudfront_distribution_id" {
  description = "Distribución CloudFront (invalidaciones de PR-6)."
  value       = module.edge.distribution_id
}

output "spa_bucket_name" {
  description = "Bucket de la SPA (s3 sync de PR-6)."
  value       = module.edge.spa_bucket_name
}

output "spa_kms_key_arn" {
  description = "CMK del bucket de la SPA (el rol de despliegue de PR-6 necesita kms:GenerateDataKey)."
  value       = module.edge.spa_kms_key_arn
}

output "ecr_repository_urls" {
  description = "Repositorios ECR (push de PR-6)."
  value       = module.registry.repository_urls
}

output "ecs_cluster_name" {
  description = "Clúster ECS."
  value       = module.ecs.cluster_name
}

output "ecs_service_names" {
  description = "Servicios ECS."
  value       = module.ecs.service_names
}

output "ops_task_definition_families" {
  description = "Tareas run-task de DT-09, en el orden de ejecución: db-provision, identity/catalog/commerce/audit-migrate, db-finalize."
  value       = module.ecs.ops_task_definition_families
}

output "run_task_network_configuration" {
  description = "awsvpcConfiguration para `aws ecs run-task` de las tareas de operación (sin IP pública)."
  value = {
    subnets        = module.network.app_subnet_ids
    securityGroups = [module.security_groups.ops_sg_id]
    assignPublicIp = "DISABLED"
  }
}

output "rds_address" {
  description = "Endpoint privado de RDS (no accesible desde Internet)."
  value       = module.database.address
}

output "rds_master_secret_arn" {
  description = "Secreto del maestro gestionado por RDS (solo db-provision/db-finalize)."
  value       = module.database.master_secret_arn
}

output "secret_names" {
  description = "Secretos de la aplicación (sin valores)."
  value       = module.secrets.secret_names
}

output "jwt_kms_key_alias" {
  description = "Alias de la clave de firma de JWT."
  value       = module.kms.jwt_key_alias
}

output "waf_web_acl_arn" {
  description = "Web ACL de CloudFront."
  value       = module.edge.web_acl_arn
}

output "alarm_topic_arn" {
  description = "Tema SNS de las alarmas."
  value       = module.observability.alarm_topic_arn
}

output "log_group_names" {
  description = "Log groups por carga de trabajo."
  value       = module.observability.log_group_names
}

output "vpc_id" {
  description = "VPC del laboratorio."
  value       = module.network.vpc_id
}

output "internet_gateway_id" {
  description = "IGW asociado solo por requisito de CloudFront VPC origins (sin rutas; verificar en EV-AWS-LAB-RED)."
  value       = module.network.internet_gateway_id
}
