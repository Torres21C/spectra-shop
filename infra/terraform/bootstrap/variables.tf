variable "aws_region" {
  description = "Región del bucket del state."
  type        = string
  default     = "us-east-1"
}

variable "noncurrent_version_days" {
  description = "Días que se conservan las versiones anteriores del state."
  type        = number
  default     = 90
}

variable "state_admin_role_arns" {
  description = "ARN de los roles (Identity Center, CI de PR-6) autorizados a leer y escribir el state. Vacío = solo IAM de la cuenta."
  type        = list(string)
  default     = []
}
