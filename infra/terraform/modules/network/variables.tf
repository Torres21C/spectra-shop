variable "name_prefix" {
  description = "Prefijo de nombres de recursos (p. ej. spectra-lab)."
  type        = string
}

variable "environment" {
  description = "Nombre del entorno (lab)."
  type        = string
}

variable "region" {
  description = "Región AWS."
  type        = string
}

variable "account_id" {
  description = "ID de la cuenta AWS (condición aws:SourceAccount del rol de flow logs)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR de la VPC."
  type        = string
}

variable "az_ids" {
  description = "AZ IDs de las dos subredes de cada capa (sin use1-az3)."
  type        = list(string)
}

variable "app_subnet_cidrs" {
  description = "CIDR de las subredes privadas de aplicación, en el orden de az_ids."
  type        = list(string)
}

variable "data_subnet_cidrs" {
  description = "CIDR de las subredes privadas de datos, en el orden de az_ids."
  type        = list(string)
}

variable "enable_flow_logs" {
  description = "Activa VPC Flow Logs hacia CloudWatch Logs."
  type        = bool
}

variable "log_retention_days" {
  description = "Retención de los flow logs, en días."
  type        = number
}

variable "logs_kms_key_arn" {
  description = "ARN de la CMK con la que se cifran los log groups."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary obligatoria para el rol de entrega de VPC Flow Logs."
  type        = string
}
