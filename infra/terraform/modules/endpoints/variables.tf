variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "region" {
  description = "Región AWS."
  type        = string
}

variable "vpc_id" {
  description = "ID de la VPC."
  type        = string
}

variable "subnet_ids" {
  description = "Subredes de aplicación candidatas (en orden)."
  type        = list(string)
}

variable "az_count" {
  description = "Número de AZ con endpoints (1 o 2). Cada endpoint cobra por hora y por AZ."
  type        = number
}

variable "endpoints_sg_id" {
  description = "Security group de los endpoints."
  type        = string
}
