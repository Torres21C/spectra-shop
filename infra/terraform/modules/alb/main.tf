# ALB interno (plan §6.2). Solo lo alcanza CloudFront por el VPC origin (ADR-AWS-05).
#
# C5 (desviación de laboratorio, ADR-AWS-05 D-AWS-05-06): listener HTTP:80. El tráfico CloudFront → ALB
# viaja por la red de AWS hasta el origen privado y ALB → tareas por subredes privadas sin ruta a Internet.
# Controles compensatorios: ALB sin IP pública, SG con origen único (CloudFront), SG por servicio y por
# puerto, rutas explícitas con 404 por defecto, cabeceras inválidas descartadas y WAF en el borde.
#
# Las rutas coinciden con los decoradores de los controladores (`main` a0f8052). Las rutas /health*, /docs*
# e /internal/* no se enrutan; los puertos internos 3101, 3102 y 3104 nunca se registran en el ALB.

locals {
  services = {
    identity = { port = 3001 }
    catalog  = { port = 3002 }
    commerce = { port = 3003 }
    audit    = { port = 3004 }
  }

  # Máximo 5 valores por condición path-pattern.
  rules = {
    identity-auth = {
      priority = 10
      service  = "identity"
      paths    = ["/auth/*"]
    }
    catalog-public = {
      priority = 20
      service  = "catalog"
      paths    = ["/categories", "/products", "/products/*", "/admin/products", "/admin/products/*"]
    }
    commerce-client = {
      priority = 30
      service  = "commerce"
      paths    = ["/cart", "/cart/*", "/checkout/*", "/orders", "/orders/*"]
    }
    commerce-admin = {
      priority = 40
      service  = "commerce"
      paths    = ["/admin/orders", "/admin/orders/*"]
    }
    audit-admin = {
      priority = 50
      service  = "audit"
      paths    = ["/admin/audit-events", "/admin/audit-events/*"]
    }
  }
}

resource "aws_lb" "this" {
  # checkov:skip=CKV2_AWS_20:C5 desviación de laboratorio (ADR-AWS-05): ALB interno sin listener HTTPS al que redirigir; solo lo alcanza CloudFront por VPC origin y TLS termina en CloudFront.
  # checkov:skip=CKV_AWS_150:Laboratorio destruible con IaC; la protección se activa con la variable deletion_protection.
  # checkov:skip=CKV_AWS_91:Registros de acceso del ALB opcionales (variable access_logs_bucket); el borde ya registra en WAF con redacción.
  # Nota (CKV2_AWS_28, no evaluado como fallo por Checkov 3.4.6): El WAF está en CloudFront (único punto de entrada); el ALB es interno y solo admite CloudFront.
  name               = var.name
  internal           = true
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = [var.alb_sg_id]
  ip_address_type    = "ipv4"

  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  # Conserva la cadena X-Forwarded-For de CloudFront y añade la IP que ve el ALB (AWS-11, prueba P10).
  xff_header_processing_mode = "append"
  enable_xff_client_port     = false
  preserve_host_header       = false
  idle_timeout               = 60
  enable_deletion_protection = var.deletion_protection

  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [var.access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.name
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "service" {
  # checkov:skip=CKV_AWS_378:C5 desviación de laboratorio (ADR-AWS-05): HTTP dentro de la VPC entre el ALB interno y las tareas, con SG por servicio; TLS termina en CloudFront.
  for_each = local.services

  name                 = "${var.name}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  # ADR-AWS-04 D-AWS-04-04: readiness con SELECT 1 a la base del servicio; 503 retira la tarea.
  health_check {
    enabled             = true
    path                = "/health/ready"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  # checkov:skip=CKV_AWS_2:C5 desviación de laboratorio (ADR-AWS-05): ALB interno solo alcanzable por CloudFront VPC origin; TLS termina en CloudFront.
  # checkov:skip=CKV_AWS_103:C5 desviación de laboratorio (ADR-AWS-05): listener HTTP interno.
  # Nota (CKV2_AWS_74, no evaluado como fallo por Checkov 3.4.6): C5 desviación de laboratorio (ADR-AWS-05): listener HTTP interno.
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ statusCode = 404, message = "Not Found" })
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "route" {
  for_each = local.rules

  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.value.service].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }
}
