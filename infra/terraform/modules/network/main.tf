# Red privada del laboratorio (AD-04, AD-05 modificada por ADR-AWS-05).
#
# - Solo subredes privadas: ninguna tabla de rutas tiene una ruta 0.0.0.0/0 ni ::/0.
# - El Internet Gateway existe únicamente porque CloudFront VPC origins lo exige para «denotar que la VPC
#   puede recibir tráfico de Internet»; no lo usa para enrutar hacia el origen y ninguna tabla de rutas lo
#   referencia (ADR-AWS-05, D-AWS-05-02).
# - Las subredes se fijan por AZ ID (no por nombre de AZ, que varía entre cuentas) para excluir use1-az3,
#   que CloudFront VPC origins no admite.

locals {
  app_subnets  = { for idx, az_id in var.az_ids : az_id => var.app_subnet_cidrs[idx] }
  data_subnets = { for idx, az_id in var.az_ids : az_id => var.data_subnet_cidrs[idx] }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

# Grupo de seguridad por defecto sin reglas: ningún recurso debe usarlo (CIS 5.4).
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-default-sg-unused" }
}

# Requisito de CloudFront VPC origins. Sin rutas: ver aws_route_table.* (solo la ruta local implícita y el
# gateway endpoint de S3).
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name    = "${var.name_prefix}-igw-vpc-origins-only"
    Purpose = "cloudfront-vpc-origins-requirement-no-routes"
  }
}

resource "aws_subnet" "app" {
  for_each = local.app_subnets

  vpc_id                  = aws_vpc.this.id
  availability_zone_id    = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-app-${each.key}"
    Tier = "app"
  }
}

resource "aws_subnet" "data" {
  for_each = local.data_subnets

  vpc_id                  = aws_vpc.this.id
  availability_zone_id    = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-data-${each.key}"
    Tier = "data"
  }
}

# Tablas de rutas sin rutas explícitas: solo la ruta local de la VPC y, en la de aplicación, el prefix list
# de S3 que añade el gateway endpoint. Ninguna ruta hacia el IGW ni hacia NAT.
resource "aws_route_table" "app" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-rt-app-private" }
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-rt-data-private" }
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app.id
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# La tabla principal de la VPC tampoco tiene rutas; se etiqueta para identificarla en las evidencias.
resource "aws_default_route_table" "this" {
  default_route_table_id = aws_vpc.this.default_route_table_id

  tags = { Name = "${var.name_prefix}-rt-main-unused" }
}

# Gateway endpoint de S3 (sin costo): capas de las imágenes de ECR. Solo para las subredes de aplicación.
# Política restringida al bucket de capas de ECR de la región (patrón documentado por AWS para ECR con
# VPC endpoints): las tareas no pueden leer ni escribir otros buckets por esta vía.
data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "EcrImageLayersOnly"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app.id]
  policy            = data.aws_iam_policy_document.s3_endpoint.json

  tags = { Name = "${var.name_prefix}-vpce-s3" }
}

# VPC Flow Logs (evidencia EV-AWS-LAB-RED y detección de tráfico inesperado).
resource "aws_cloudwatch_log_group" "flow_logs" {
  # checkov:skip=CKV_AWS_338:Retención de 30 días en el laboratorio (plan §5, paso 8; costo). Exportar a la bóveda las evidencias necesarias antes de que expiren.
  count = var.enable_flow_logs ? 1 : 0

  name              = "/spectra/${var.environment}/vpc-flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "flow_logs_assume" {
  count = var.enable_flow_logs ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name               = "${var.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume[0].json
}

data "aws_iam_policy_document" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs[0].id
  policy = data.aws_iam_policy_document.flow_logs[0].json
}

resource "aws_flow_log" "this" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn         = aws_iam_role.flow_logs[0].arn

  tags = { Name = "${var.name_prefix}-flow-logs" }
}
