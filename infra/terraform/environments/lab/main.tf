# Laboratorio académico SPECTRA Shop en AWS (ADR-AWS-05). Este código PREPARA la infraestructura; no se
# aplica en PR-5. Orden de dependencias:
#
#   kms ─┬─▶ network ─▶ security_groups ─▶ endpoints
#        │                    │
#        ├─▶ database ◀───────┤
#        ├─▶ secrets ◀── database (endpoint para las URL)
#        ├─▶ registry
#        └─▶ observability (log groups; alarmas ◀── alb, database)
#   alb ◀── network, security_groups
#   edge (S3 + OAC, VPC origin → alb, CloudFront, WAF) ◀── alb
#   ecs (task definitions, roles, servicios) ◀── todo lo anterior; CORS_ORIGINS = dominio de edge

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "spectra-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id

  services = ["identity", "catalog", "commerce", "audit"]
  ops      = ["db-provision", "identity-migrate", "catalog-migrate", "commerce-migrate", "audit-migrate", "db-finalize"]

  repositories = ["identity-service", "catalog-service", "commerce-service", "audit-service", "db-ops"]
}

module "kms" {
  source = "../../modules/kms"

  name_prefix          = local.name_prefix
  region               = var.aws_region
  account_id           = local.account_id
  deletion_window_days = var.kms_deletion_window_days
}

module "network" {
  source = "../../modules/network"

  name_prefix        = local.name_prefix
  environment        = var.environment
  region             = var.aws_region
  account_id         = local.account_id
  vpc_cidr           = var.vpc_cidr
  az_ids             = var.az_ids
  app_subnet_cidrs   = var.app_subnet_cidrs
  data_subnet_cidrs  = var.data_subnet_cidrs
  enable_flow_logs   = var.enable_flow_logs
  log_retention_days = var.log_retention_days
  logs_kms_key_arn   = module.kms.data_key_arn
}

module "security_groups" {
  source = "../../modules/security_groups"

  name_prefix        = local.name_prefix
  vpc_id             = module.network.vpc_id
  s3_prefix_list_id  = module.network.s3_prefix_list_id
  alb_ingress_source = var.alb_ingress_source
}

module "endpoints" {
  source = "../../modules/endpoints"

  name_prefix     = local.name_prefix
  region          = var.aws_region
  vpc_id          = module.network.vpc_id
  subnet_ids      = module.network.app_subnet_ids
  az_count        = var.interface_endpoint_az_count
  endpoints_sg_id = module.security_groups.endpoints_sg_id
}

module "database" {
  source = "../../modules/database"

  identifier                = "${local.name_prefix}-db"
  engine_version            = var.db_engine_version
  instance_class            = var.db_instance_class
  db_name                   = var.db_name
  master_username           = var.db_master_username
  allocated_storage_gb      = var.db_allocated_storage_gb
  max_allocated_storage_gb  = var.db_max_allocated_storage_gb
  subnet_ids                = module.network.data_subnet_ids
  rds_sg_id                 = module.security_groups.rds_sg_id
  kms_key_arn               = module.kms.data_key_arn
  ca_cert_identifier        = var.db_ca_cert_identifier
  backup_retention_days     = var.db_backup_retention_days
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_final_snapshot_identifier
  apply_immediately         = var.db_apply_immediately
  log_retention_days        = var.log_retention_days
}

module "secrets" {
  source = "../../modules/secrets"

  secret_prefix         = "spectra/${var.environment}"
  kms_key_arn           = module.kms.data_key_arn
  recovery_window_days  = var.secret_recovery_window_days
  db_address            = module.database.address
  db_port               = module.database.port
  db_name               = module.database.db_name
  connection_limit      = var.db_connection_limit
  synthetic_admin_email = var.synthetic_admin_email
  secret_versions       = var.secret_versions
}

module "registry" {
  source = "../../modules/registry"

  repository_prefix = "spectra"
  repositories      = local.repositories
  kms_key_arn       = module.kms.data_key_arn
  force_delete      = var.ecr_force_delete
  keep_images       = var.ecr_keep_images
}

# PR-6: rol publicador de imágenes para GitHub Actions (OIDC). Desactivado por defecto (enable_ecr_publisher).
module "ecr_publisher" {
  source = "../../modules/github_oidc_publisher"

  enabled                    = var.enable_ecr_publisher
  name_prefix                = local.name_prefix
  create_oidc_provider       = var.create_github_oidc_provider
  existing_oidc_provider_arn = var.github_oidc_provider_arn
  oidc_subject_prefix        = var.github_oidc_subject_prefix
  github_environment         = var.github_publish_environment
  repository_arns            = module.registry.repository_arns
}

module "alb" {
  source = "../../modules/alb"

  name                = "${local.name_prefix}-api"
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.app_subnet_ids
  alb_sg_id           = module.security_groups.alb_sg_id
  deletion_protection = var.alb_deletion_protection
}

module "observability" {
  source = "../../modules/observability"

  name_prefix               = local.name_prefix
  environment               = var.environment
  workloads                 = concat(local.services, local.ops)
  log_retention_days        = var.log_retention_days
  kms_key_arn               = module.kms.data_key_arn
  alarm_email               = var.alarm_email
  alb_arn_suffix            = module.alb.arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes
  alb_5xx_threshold         = var.alb_5xx_threshold
  db_identifier             = module.database.identifier
  budget_limit_usd          = var.budget_limit_usd
  budget_alert_percentages  = var.budget_alert_percentages
  budget_emails             = var.budget_emails
}

module "edge" {
  source = "../../modules/edge"

  name_prefix              = local.name_prefix
  account_id               = local.account_id
  kms_deletion_window_days = var.kms_deletion_window_days
  spa_bucket_name          = "${local.name_prefix}-spa-${local.account_id}"
  spa_bucket_force_destroy = var.spa_bucket_force_destroy
  alb_arn                  = module.alb.arn
  alb_dns_name             = module.alb.dns_name
  price_class              = var.cloudfront_price_class
  enable_ipv6              = var.enable_ipv6
  domain_name              = var.domain_name
  acm_certificate_arn      = var.acm_certificate_arn
  route53_zone_id          = var.route53_zone_id
  waf_auth_rate_limit      = var.waf_auth_rate_limit
  waf_global_rate_limit    = var.waf_global_rate_limit
  log_retention_days       = var.log_retention_days
  logs_kms_key_arn         = module.kms.data_key_arn
}

module "ecs" {
  source = "../../modules/ecs"

  name_prefix                 = local.name_prefix
  region                      = var.aws_region
  account_id                  = local.account_id
  cluster_name                = local.name_prefix
  vpc_id                      = module.network.vpc_id
  app_subnet_ids              = module.network.app_subnet_ids
  service_sg_ids              = module.security_groups.service_sg_ids
  target_group_arns           = module.alb.target_group_arns
  service_discovery_namespace = "spectra.internal"
  repository_urls             = module.registry.repository_urls
  repository_arns             = module.registry.repository_arns
  image_tag                   = var.image_tag
  cpu_architecture            = var.cpu_architecture
  service_desired_count       = var.service_desired_count
  service_sizes               = var.service_sizes
  ops_size                    = var.ops_size
  readonly_root_filesystem    = var.readonly_root_filesystem
  container_insights          = var.container_insights
  log_group_names             = module.observability.log_group_names
  log_group_arns              = module.observability.log_group_arns
  data_kms_key_arn            = module.kms.data_key_arn
  jwt_key_arn                 = module.kms.jwt_key_arn
  jwt_public_key_pem          = module.kms.jwt_public_key_pem
  public_origin               = module.edge.public_origin
  trust_proxy                 = var.trust_proxy
  db_address                  = module.database.address
  db_port                     = module.database.port
  db_name                     = module.database.db_name
  master_secret_arn           = module.database.master_secret_arn
  db_role_secret_arns         = module.secrets.db_role_secret_arns
  internal_token_secret_arn   = module.secrets.internal_token_secret_arn
  inventory_token_secret_arn  = module.secrets.inventory_token_secret_arn
  synthetic_admin_secret_arn  = module.secrets.synthetic_admin_secret_arn
  catalog_seed_demo_products  = var.catalog_seed_demo_products

  # Las tareas solo pueden arrancar cuando existen los endpoints (sin ellos no hay ECR, logs ni secretos).
  depends_on = [module.endpoints]
}
