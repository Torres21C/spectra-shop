variable "name" {
  description = "Nombre del ALB (máximo 32 caracteres; los target groups añaden -<servicio>)."
  type        = string

  validation {
    condition     = length(var.name) <= 23
    error_message = "name debe tener como máximo 23 caracteres para que los target groups no superen 32."
  }
}

variable "vpc_id" {
  description = "ID de la VPC."
  type        = string
}

variable "subnet_ids" {
  description = "Subredes privadas de aplicación (2 AZ)."
  type        = list(string)
}

variable "alb_sg_id" {
  description = "Security group del ALB."
  type        = string
}

variable "deletion_protection" {
  description = "Protección contra borrado del ALB."
  type        = bool
}

variable "access_logs_bucket" {
  description = "Bucket S3 existente para los registros de acceso del ALB (null = desactivados)."
  type        = string
  default     = null
}
