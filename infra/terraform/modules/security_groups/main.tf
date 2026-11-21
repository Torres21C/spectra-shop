# Security groups con mínimo privilegio (plan §7, AWS-17). Una regla por flujo legítimo; ninguna regla usa
# 0.0.0.0/0 ni el puerto 22. Los puertos internos (3101, 3102, 3104) solo los alcanza su consumidor real y
# nunca el ALB.

locals {
  services = ["identity", "catalog", "commerce", "audit"]

  public_ports = {
    identity = 3001
    catalog  = 3002
    commerce = 3003
    audit    = 3004
  }

  # Listeners internos: consumidor → proveedor (código: *_INTERNAL_URL).
  internal_flows = {
    "catalog-to-identity"  = { from = "catalog", to = "identity", port = 3101 }
    "commerce-to-identity" = { from = "commerce", to = "identity", port = 3101 }
    "audit-to-identity"    = { from = "audit", to = "identity", port = 3101 }
    "commerce-to-catalog"  = { from = "commerce", to = "catalog", port = 3102 }
    "catalog-to-audit"     = { from = "catalog", to = "audit", port = 3104 }
  }

  # Cargas de trabajo que hablan con PostgreSQL y con los VPC endpoints.
  db_clients = concat(local.services, ["ops"])
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  count = var.alb_ingress_source == "prefix_list" ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

# Grupo gestionado por CloudFront; solo existe después de crear el VPC origin (segunda fase, ADR-AWS-05).
data "aws_security_group" "cloudfront_vpc_origins" {
  count = var.alb_ingress_source == "vpc_origin_sg" ? 1 : 0

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }
}

resource "aws_security_group" "alb" {
  # checkov:skip=CKV2_AWS_5:Falso positivo: el SG se asocia al ALB en el módulo alb (variable alb_sg_id); el grafo de Checkov no sigue las referencias entre módulos.
  name        = "${var.name_prefix}-alb"
  description = "ALB interno: entrada solo desde CloudFront VPC origins"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-alb" }
}

resource "aws_security_group" "service" {
  # checkov:skip=CKV2_AWS_5:Falso positivo: cada SG se asocia a su servicio ECS en el módulo ecs (service_sg_ids); el grafo de Checkov no sigue las referencias entre módulos.
  for_each = toset(local.services)

  name        = "${var.name_prefix}-${each.key}"
  description = "Tareas ECS de ${each.key}-service"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-${each.key}" }
}

resource "aws_security_group" "ops" {
  # checkov:skip=CKV2_AWS_5:Por diseño: el SG de las tareas DT-09 se usa al lanzarlas manualmente (salida run_task_network_configuration); ningún recurso de Terraform lo asocia.
  name        = "${var.name_prefix}-ops"
  description = "Tareas run-task de aprovisionamiento y migracion (DT-09)"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-ops" }
}

resource "aws_security_group" "rds" {
  # checkov:skip=CKV2_AWS_5:Falso positivo: el SG se asocia a la instancia RDS en el módulo database (rds_sg_id); el grafo de Checkov no sigue las referencias entre módulos.
  name        = "${var.name_prefix}-rds"
  description = "RDS PostgreSQL: 5432 solo desde servicios y tareas de operacion"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-rds" }
}

resource "aws_security_group" "endpoints" {
  # checkov:skip=CKV2_AWS_5:Falso positivo: el SG se asocia a los interface endpoints en el módulo endpoints (endpoints_sg_id); el grafo de Checkov no sigue las referencias entre módulos.
  name        = "${var.name_prefix}-vpce"
  description = "VPC interface endpoints: 443 solo desde servicios y tareas de operacion"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-vpce" }
}

# ---------------------------------------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront_prefix_list" {
  # checkov:skip=CKV_AWS_260:Falso positivo: el origen es el prefix list gestionado com.amazonaws.global.cloudfront.origin-facing, no 0.0.0.0/0; el ALB es interno y solo lo alcanza el VPC origin.
  count = var.alb_ingress_source == "prefix_list" ? 1 : 0

  security_group_id = aws_security_group.alb.id
  description       = "HTTP desde CloudFront (prefix list origin-facing)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing[0].id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpc_origin_sg" {
  count = var.alb_ingress_source == "vpc_origin_sg" ? 1 : 0

  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP solo desde el SG gestionado de CloudFront VPC origins"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origins[0].id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  for_each = local.public_ports

  security_group_id            = aws_security_group.alb.id
  description                  = "Trafico y health checks hacia ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
  referenced_security_group_id = aws_security_group.service[each.key].id
}

# ---------------------------------------------------------------------------------------------------------
# Servicios: entrada pública desde el ALB e internas entre servicios
# ---------------------------------------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  for_each = local.public_ports

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "Puerto publico ${each.value} solo desde el ALB"
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "internal" {
  for_each = local.internal_flows

  security_group_id            = aws_security_group.service[each.value.to].id
  description                  = "Listener interno ${each.value.port} desde ${each.value.from}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = aws_security_group.service[each.value.from].id
}

resource "aws_vpc_security_group_egress_rule" "internal" {
  for_each = local.internal_flows

  security_group_id            = aws_security_group.service[each.value.from].id
  description                  = "Hacia el listener interno ${each.value.port} de ${each.value.to}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = aws_security_group.service[each.value.to].id
}

# ---------------------------------------------------------------------------------------------------------
# PostgreSQL, VPC endpoints y S3 (servicios y tareas de operación)
# ---------------------------------------------------------------------------------------------------------
locals {
  client_sg_ids = merge(
    { for name in local.services : name => aws_security_group.service[name].id },
    { ops = aws_security_group.ops.id },
  )
}

resource "aws_vpc_security_group_egress_rule" "to_rds" {
  for_each = toset(local.db_clients)

  security_group_id            = local.client_sg_ids[each.key]
  description                  = "PostgreSQL (TLS, sslmode=require)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_client" {
  for_each = toset(local.db_clients)

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL desde ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = local.client_sg_ids[each.key]
}

resource "aws_vpc_security_group_egress_rule" "to_endpoints" {
  for_each = toset(local.db_clients)

  security_group_id            = local.client_sg_ids[each.key]
  description                  = "HTTPS hacia los VPC interface endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_client" {
  for_each = toset(local.db_clients)

  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS desde ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = local.client_sg_ids[each.key]
}

resource "aws_vpc_security_group_egress_rule" "to_s3" {
  for_each = toset(local.db_clients)

  security_group_id = local.client_sg_ids[each.key]
  description       = "HTTPS hacia S3 por el gateway endpoint (capas de ECR)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = var.s3_prefix_list_id
}
