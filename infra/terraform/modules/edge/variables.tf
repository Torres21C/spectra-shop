variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "spa_bucket_name" {
  description = "Nombre global del bucket de la SPA."
  type        = string
}

variable "spa_bucket_force_destroy" {
  description = "Permite destruir el bucket con objetos (todas las versiones)."
  type        = bool
}

variable "alb_arn" {
  description = "ARN del ALB interno (VPC origin)."
  type        = string
}

variable "alb_dns_name" {
  description = "Nombre DNS interno del ALB."
  type        = string
}

variable "price_class" {
  description = "Clase de precio de CloudFront."
  type        = string
}

variable "enable_ipv6" {
  description = "IPv6 en el borde (el origen VPC sigue siendo IPv4)."
  type        = bool
}

variable "domain_name" {
  description = "Dominio propio opcional (null = *.cloudfront.net)."
  type        = string
  default     = null
}

variable "acm_certificate_arn" {
  description = "Certificado ACM validado en us-east-1 para domain_name."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Zona alojada para crear el alias (opcional)."
  type        = string
  default     = null
}

variable "waf_auth_rate_limit" {
  description = "Peticiones a /auth/* por IP en 5 minutos antes de bloquear."
  type        = number
}

variable "waf_global_rate_limit" {
  description = "Peticiones totales por IP en 5 minutos antes de bloquear."
  type        = number
}

variable "log_retention_days" {
  description = "Retención de los logs de WAF."
  type        = number
}

variable "logs_kms_key_arn" {
  description = "CMK de los log groups."
  type        = string
}

variable "account_id" {
  description = "ID de la cuenta AWS (política de la clave de la SPA)."
  type        = string
}

variable "kms_deletion_window_days" {
  description = "Ventana de borrado programado de la clave de la SPA (7-30)."
  type        = number
}
