variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
}

variable "region" {
  description = "Región AWS."
  type        = string
}

variable "account_id" {
  description = "ID de la cuenta AWS."
  type        = string
}

variable "cluster_name" {
  description = "Nombre del clúster ECS."
  type        = string
}

variable "vpc_id" {
  description = "ID de la VPC (espacio de Cloud Map)."
  type        = string
}

variable "app_subnet_ids" {
  description = "Subredes privadas de aplicación."
  type        = list(string)
}

variable "service_sg_ids" {
  description = "Security group de cada servicio."
  type        = map(string)
}

variable "target_group_arns" {
  description = "Target group de cada servicio."
  type        = map(string)
}

variable "service_discovery_namespace" {
  description = "Espacio DNS privado de Cloud Map."
  type        = string
}

variable "repository_urls" {
  description = "URL de cada repositorio ECR."
  type        = map(string)
}

variable "repository_arns" {
  description = "ARN de cada repositorio ECR."
  type        = map(string)
}

variable "image_digests" {
  description = "Digests por nombre de imagen en el manifiesto de publicación ECR."
  type        = map(string)
  default     = null

  validation {
    condition = var.image_digests == null ? true : (
      toset(keys(var.image_digests)) == toset(concat(["db-ops"], flatten([
        for service in ["identity", "catalog", "commerce", "audit"] :
        ["${service}-service-runtime", "${service}-service-migrate"]
      ]))) && alltrue([for digest in values(var.image_digests) : can(regex("^sha256:[0-9a-f]{64}$", digest))])
    )
    error_message = "image_digests debe contener los nueve digests SHA-256 del manifiesto ECR."
  }
}

variable "image_tag" {
  description = "SHA completo del commit publicado por PR-6 (runtime: <sha>; migración: <sha>-migrate)."
  type        = string
}

variable "cpu_architecture" {
  description = "Arquitectura de las tareas (debe coincidir con la de las imágenes, AWS-09)."
  type        = string
}

variable "service_desired_count" {
  description = "Tareas por servicio."
  type        = number
}

variable "service_sizes" {
  description = "CPU y memoria de cada servicio (unidades de Fargate)."
  type = map(object({
    cpu    = number
    memory = number
  }))
}

variable "ops_size" {
  description = "CPU y memoria de las tareas de operación."
  type = object({
    cpu    = number
    memory = number
  })
}

variable "readonly_root_filesystem" {
  description = "Sistema de archivos raíz de solo lectura en los servicios (AWS-24)."
  type        = bool
}

variable "container_insights" {
  description = "Container Insights del clúster (con costo)."
  type        = bool
}

variable "log_group_names" {
  description = "Log group de cada carga de trabajo."
  type        = map(string)
}

variable "log_group_arns" {
  description = "ARN del log group de cada carga de trabajo."
  type        = map(string)
}

variable "data_kms_key_arn" {
  description = "CMK con la que se cifran los secretos."
  type        = string
}

variable "jwt_key_arn" {
  description = "Clave KMS de firma de JWT."
  type        = string
}

variable "jwt_public_key_pem" {
  description = "Clave pública PEM de la clave de firma (IDENTITY_PUBLIC_KEY_PEM)."
  type        = string
}

variable "public_origin" {
  description = "Origen público https://<dominio> (CORS_ORIGINS)."
  type        = string
}

variable "trust_proxy" {
  description = "Valor de TRUST_PROXY (validado en el entorno)."
  type        = string
}

variable "db_address" {
  description = "Nombre DNS privado de RDS."
  type        = string
}

variable "db_port" {
  description = "Puerto de PostgreSQL."
  type        = number
}

variable "db_name" {
  description = "Nombre de la base."
  type        = string
}

variable "master_secret_arn" {
  description = "Secreto del maestro gestionado por RDS."
  type        = string
}

variable "db_role_secret_arns" {
  description = "Secreto de cada rol DT-09."
  type        = map(string)
}

variable "internal_token_secret_arn" {
  description = "Secreto del token interno."
  type        = string
}

variable "inventory_token_secret_arn" {
  description = "Secreto del token de inventario."
  type        = string
}

variable "synthetic_admin_secret_arn" {
  description = "Secreto del ADMIN sintético (null = sin ADMIN sintético)."
  type        = string
  default     = null
}

variable "catalog_seed_demo_products" {
  description = "catalog-migrate ejecuta el seed de productos de demostración (AWS-25)."
  type        = bool
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary obligatoria para todos los roles de ejecución y tarea de ECS."
  type        = string
}
