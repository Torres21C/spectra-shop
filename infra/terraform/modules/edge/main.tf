# Borde público único (AD-07, AWS-05, ADR-AWS-05): una distribución CloudFront sirve la SPA (S3 privado con
# OAC) y las API (VPC origin → ALB interno) bajo el MISMO origen. Así las cookies __Host- (sin Domain,
# Secure, SameSite=Strict) que emite Identity llegan a Catalog, Commerce y Audit, y el CSRF de doble envío
# con comprobación de Origin funciona con CORS_ORIGINS = https://<dominio>.
#
# Comportamientos de API (plan §6.1): sin caché (Managed-CachingDisabled) y reenviando todo excepto Host
# (Managed-AllViewerExceptHostHeader: Cookie, Origin, X-CSRF-Token, Idempotency-Key, query). /health*,
# /docs* e /internal/* NO se enrutan: caen en S3 y devuelven 403.

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  custom_domain = var.domain_name != null

  api_all_methods  = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
  api_read_methods = ["GET", "HEAD", "OPTIONS"]

  # Orden = precedencia en CloudFront. 10 comportamientos + el de por defecto (límite: 25).
  api_behaviors = [
    { path = "/auth/*", methods = local.api_all_methods },
    { path = "/categories", methods = local.api_read_methods },
    { path = "/products", methods = local.api_read_methods },
    { path = "/products/*", methods = local.api_read_methods },
    { path = "/cart", methods = local.api_all_methods },
    { path = "/cart/*", methods = local.api_all_methods },
    { path = "/checkout/*", methods = local.api_all_methods },
    { path = "/orders", methods = local.api_all_methods },
    { path = "/orders/*", methods = local.api_all_methods },
    { path = "/admin/*", methods = local.api_all_methods },
  ]

  # CSP de la SPA servida por CloudFront (AWS-16). Igual que la meta CSP que genera `vite build`
  # (apps/web/src/csp-policy.ts) con la API en el mismo origen, más frame-ancestors (solo válido en cabecera).
  spa_csp = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
}

# ---------------------------------------------------------------------------------------------------------
# SPA en S3 privado
# ---------------------------------------------------------------------------------------------------------
resource "aws_s3_bucket" "spa" {
  # checkov:skip=CKV_AWS_18:Registro de accesos del bucket no requerido: solo CloudFront (OAC) lee; WAF registra las peticiones.
  # checkov:skip=CKV_AWS_144:Replicación entre regiones innecesaria: el contenido se reconstruye desde el repositorio (PR-6).
  # checkov:skip=CKV2_AWS_62:Sin notificaciones de eventos: no hay consumidores.
  bucket        = var.spa_bucket_name
  force_destroy = var.spa_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket = aws_s3_bucket.spa.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "spa" {
  bucket = aws_s3_bucket.spa.id

  versioning_configuration {
    status = "Enabled"
  }
}

# CMK dedicada a la SPA: solo esta distribución (OAC) puede descifrar. Es independiente de la CMK de datos
# (RDS y secretos), para no ampliar los principales de servicio de esa clave. La política se asocia en un
# recurso aparte (aws_kms_key_policy) porque necesita el ARN de la distribución, que a su vez depende del
# bucket cifrado con esta clave.
resource "aws_kms_key" "spa" {
  description             = "${var.name_prefix}: cifrado del bucket de la SPA (lectura solo por CloudFront OAC)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.kms_deletion_window_days
}

resource "aws_kms_alias" "spa" {
  name          = "alias/${var.name_prefix}-spa"
  target_key_id = aws_kms_key.spa.key_id
}

data "aws_iam_policy_document" "spa_key" {
  # checkov:skip=CKV_AWS_109:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_111:Política de clave: «*» en resources significa «esta clave»; la raíz delega en IAM.
  # checkov:skip=CKV_AWS_356:Política de clave: «*» en resources significa «esta clave».
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowThisDistributionToDecrypt"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_kms_key_policy" "spa" {
  key_id = aws_kms_key.spa.id
  policy = data.aws_iam_policy_document.spa_key.json
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.spa.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    id     = "expire-noncurrent-builds"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "spa" {
  statement {
    sid       = "AllowCloudFrontOacRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.spa.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.spa.arn,
      "${aws_s3_bucket.spa.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = data.aws_iam_policy_document.spa.json

  depends_on = [aws_s3_bucket_public_access_block.spa]
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.name_prefix}-spa"
  description                       = "OAC de la SPA"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---------------------------------------------------------------------------------------------------------
# VPC origin → ALB interno (ADR-AWS-05)
# ---------------------------------------------------------------------------------------------------------
resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name       = "${var.name_prefix}-alb"
    arn        = var.alb_arn
    http_port  = 80
    https_port = 443
    # C5 (ADR-AWS-05, D-AWS-05-06): HTTP hasta el ALB interno; el TLS público termina en CloudFront.
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

# ---------------------------------------------------------------------------------------------------------
# Políticas de cabeceras de respuesta
# ---------------------------------------------------------------------------------------------------------
resource "aws_cloudfront_response_headers_policy" "spa" {
  # checkov:skip=CKV_AWS_259:HSTS de 1 año con includeSubDomains y override; sin «preload» a propósito: la lista de precarga exige registrar el dominio raíz (imposible en *.cloudfront.net; decisión del propietario si hay dominio propio).
  name    = "${var.name_prefix}-spa-security"
  comment = "SPA: CSP de produccion, HSTS y cabeceras de seguridad (AWS-16)"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.spa_csp
      override                = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    xss_protection {
      protection = false
      override   = true
    }
  }
}

# Las API ya devuelven su propia CSP (Helmet, default-src 'none'); esta política no la sustituye.
resource "aws_cloudfront_response_headers_policy" "api" {
  # checkov:skip=CKV_AWS_259:HSTS de 1 año con includeSubDomains y override; sin «preload» a propósito: la lista de precarga exige registrar el dominio raíz (imposible en *.cloudfront.net; decisión del propietario si hay dominio propio).
  name    = "${var.name_prefix}-api-security"
  comment = "API: HSTS y cabeceras de seguridad sin reemplazar la CSP de Helmet"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

# ---------------------------------------------------------------------------------------------------------
# Distribución
# ---------------------------------------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "this" {
  # checkov:skip=CKV2_AWS_47:La protección Log4j está activa (AWSManagedRulesKnownBadInputsRuleSet, regla Log4JRCE). La comprobación exige además AWSManagedRulesAnonymousIpList, que bloquearía VPN y proveedores de nube: decisión pendiente del propietario.
  # checkov:skip=CKV_AWS_86:Registro estándar de CloudFront opcional; las peticiones se registran en los logs de WAF (con redacción de cookies y tokens).
  # checkov:skip=CKV_AWS_310:Sin failover de origen en el laboratorio (un solo ALB y un solo bucket).
  # checkov:skip=CKV_AWS_374:Sin restricción geográfica: laboratorio académico sin requisito de geobloqueo.
  # Nota (CKV2_AWS_42, no evaluado como fallo por Checkov 3.4.6): Dominio propio opcional (decisión pendiente §18.5); sin él se usa el certificado de *.cloudfront.net.
  # checkov:skip=CKV_AWS_174:Con el certificado por defecto de *.cloudfront.net no se puede fijar TLS 1.2 mínimo; con dominio propio se usa TLSv1.2_2021.
  enabled             = true
  comment             = "${var.name_prefix}: SPA y API bajo un mismo origen"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = var.enable_ipv6
  price_class         = var.price_class
  web_acl_id          = aws_wafv2_web_acl.this.arn
  aliases             = local.custom_domain ? [var.domain_name] : []

  origin {
    origin_id                = "spa-s3"
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  origin {
    origin_id   = "api-alb"
    domain_name = var.alb_dns_name

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.alb.id
      origin_keepalive_timeout = 5
      origin_read_timeout      = 30
    }
  }

  default_cache_behavior {
    target_origin_id           = "spa-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.spa.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.api_behaviors
    iterator = behavior

    content {
      path_pattern               = behavior.value.path
      target_origin_id           = "api-alb"
      viewer_protocol_policy     = "https-only"
      allowed_methods            = behavior.value.methods
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.custom_domain ? null : true
    acm_certificate_arn            = local.custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}

# Registros DNS opcionales del dominio propio (la zona y el certificado ACM se gestionan fuera).
resource "aws_route53_record" "alias" {
  for_each = local.custom_domain && var.route53_zone_id != null ? toset(var.enable_ipv6 ? ["A", "AAAA"] : ["A"]) : toset([])

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
