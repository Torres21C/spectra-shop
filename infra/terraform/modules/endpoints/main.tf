# VPC interface endpoints (AD-05): las tareas no tienen salida a Internet. Servicios necesarios según el
# código y la plataforma:
#   ecr.api, ecr.dkr  → descarga de imágenes (las capas, por el gateway endpoint de S3)
#   logs              → driver awslogs
#   secretsmanager    → inyección de secretos en el arranque de la tarea
#   kms               → identity-service firma los JWT con kms:Sign (ADR-AWS-02)
# Por costo, se despliegan en las primeras `az_count` subredes (1 por defecto). Con 1 AZ, la caída de esa
# zona deja sin endpoints a las tareas de la otra (riesgo aceptado para el laboratorio, AWS-28).

locals {
  services   = toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms"])
  subnet_ids = slice(var.subnet_ids, 0, var.az_count)
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.services

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.subnet_ids
  security_group_ids  = [var.endpoints_sg_id]

  tags = { Name = "${var.name_prefix}-vpce-${replace(each.key, ".", "-")}" }
}
