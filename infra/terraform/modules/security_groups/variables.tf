variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "vpc_id" {
  description = "ID de la VPC."
  type        = string
}

variable "s3_prefix_list_id" {
  description = "Prefix list del gateway endpoint de S3."
  type        = string
}

variable "alb_ingress_source" {
  description = "Origen admitido en el ALB: prefix_list (CloudFront origin-facing; primera fase) o vpc_origin_sg (SG gestionado de CloudFront VPC origins; segunda fase, más restrictivo)."
  type        = string

  validation {
    condition     = contains(["prefix_list", "vpc_origin_sg"], var.alb_ingress_source)
    error_message = "alb_ingress_source debe ser prefix_list o vpc_origin_sg."
  }
}
