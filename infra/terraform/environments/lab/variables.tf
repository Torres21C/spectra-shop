# ---------------------------------------------------------------------------------------------------------
# General
# ---------------------------------------------------------------------------------------------------------
variable "aws_region" {
  description = "Región AWS. AD-01: us-east-1 (WAF de ámbito CLOUDFRONT y ACM para CloudFront)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "El laboratorio se despliega en us-east-1 (AD-01): la Web ACL de ámbito CLOUDFRONT y el certificado de CloudFront solo existen allí."
  }
}

variable "environment" {
  description = "Nombre del entorno (forma parte de nombres y etiquetas)."
  type        = string
  default     = "lab"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.environment))
    error_message = "environment: minúsculas y dígitos, de 2 a 10 caracteres."
  }
}

variable "lab_cycle_id" {
  description = "Identificador inmutable de esta creación del laboratorio. Se registra en etiquetas, evidencias y nombres de secretos; cámbielo solo después de destruir por completo el ciclo anterior."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$", var.lab_cycle_id))
    error_message = "lab_cycle_id debe tener 3-20 caracteres: minúsculas, números o guiones, y empezar/terminar en carácter alfanumérico."
  }
}

variable "lab_data_policy" {
  description = "Política de datos del laboratorio. Solo synthetic-discard: datos ficticios regenerables y ningún snapshot final cifrado con la CMK efímera."
  type        = string
  default     = "synthetic-discard"

  validation {
    condition     = var.lab_data_policy == "synthetic-discard"
    error_message = "El entorno lab solo admite lab_data_policy = synthetic-discard. La retención exige diseñar primero una CMK persistente fuera de este state."
  }
}

variable "teardown_mode" {
  description = "Habilita la configuración controlada previa al destroy. No ejecuta ninguna acción por sí sola."
  type        = bool
  default     = false

  validation {
    condition = var.teardown_mode ? (
      var.service_desired_count == 0 &&
      !var.db_deletion_protection &&
      var.spa_bucket_force_destroy &&
      !var.alb_deletion_protection
      ) : (
      var.db_deletion_protection &&
      !var.spa_bucket_force_destroy
    )
    error_message = "teardown_mode=true exige ECS a 0, RDS sin deletion protection, bucket SPA eliminable y ALB sin deletion protection; fuera del apagado se conservan las protecciones de RDS y S3."
  }
}

# ---------------------------------------------------------------------------------------------------------
# Red
# ---------------------------------------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "CIDR de la VPC."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr debe ser un CIDR IPv4 válido."
  }
}

variable "az_ids" {
  description = "Dos AZ IDs de us-east-1 para las subredes (el ALB exige 2 AZ). use1-az3 está excluida: CloudFront VPC origins no la admite."
  type        = list(string)
  default     = ["use1-az1", "use1-az2"]

  validation {
    condition     = length(var.az_ids) == 2 && length(distinct(var.az_ids)) == 2
    error_message = "az_ids debe contener exactamente dos AZ IDs distintos."
  }

  validation {
    condition     = alltrue([for az in var.az_ids : can(regex("^use1-az[0-9]+$", az))])
    error_message = "az_ids debe usar AZ IDs de us-east-1 (use1-azN), no nombres de AZ."
  }

  validation {
    condition     = !contains(var.az_ids, "use1-az3")
    error_message = "use1-az3 no admite CloudFront VPC origins (documentación de CloudFront, 2026-11-21)."
  }
}

variable "app_subnet_cidrs" {
  description = "CIDR de las subredes privadas de aplicación, en el orden de az_ids."
  type        = list(string)
  default     = ["10.20.1.0/24", "10.20.2.0/24"]

  validation {
    condition     = length(var.app_subnet_cidrs) == 2 && alltrue([for c in var.app_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "app_subnet_cidrs debe contener dos CIDR IPv4 válidos."
  }
}

variable "data_subnet_cidrs" {
  description = "CIDR de las subredes privadas de datos, en el orden de az_ids."
  type        = list(string)
  default     = ["10.20.11.0/24", "10.20.12.0/24"]

  validation {
    condition     = length(var.data_subnet_cidrs) == 2 && alltrue([for c in var.data_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "data_subnet_cidrs debe contener dos CIDR IPv4 válidos."
  }
}

variable "interface_endpoint_az_count" {
  description = "AZ con VPC interface endpoints (1 = más barato, sin redundancia; 2 = alta disponibilidad)."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.interface_endpoint_az_count)
    error_message = "interface_endpoint_az_count debe ser 1 o 2."
  }
}

variable "enable_flow_logs" {
  description = "VPC Flow Logs hacia CloudWatch Logs."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------------------------------------
# Borde
# ---------------------------------------------------------------------------------------------------------
variable "alb_ingress_source" {
  description = "Origen admitido en el ALB: prefix_list (primera fase) o vpc_origin_sg (segunda fase, solo el SG gestionado de CloudFront VPC origins; más restrictivo). Ver ADR-AWS-05."
  type        = string
  default     = "prefix_list"

  validation {
    condition     = contains(["prefix_list", "vpc_origin_sg"], var.alb_ingress_source)
    error_message = "alb_ingress_source debe ser prefix_list o vpc_origin_sg."
  }
}

variable "domain_name" {
  description = "Dominio propio opcional (decisión pendiente, plan §18.5). null = *.cloudfront.net."
  type        = string
  default     = null
}

variable "acm_certificate_arn" {
  description = "Certificado ACM en us-east-1, ya validado, para domain_name."
  type        = string
  default     = null

  validation {
    condition     = (var.acm_certificate_arn == null) == (var.domain_name == null)
    error_message = "domain_name y acm_certificate_arn se definen juntos o ninguno."
  }

  validation {
    condition     = var.acm_certificate_arn == null || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/", var.acm_certificate_arn))
    error_message = "El certificado de CloudFront debe estar en ACM de us-east-1."
  }
}

variable "route53_zone_id" {
  description = "Zona de Route 53 para el alias del dominio propio (opcional)."
  type        = string
  default     = null
}

variable "cloudfront_price_class" {
  description = "Clase de precio de CloudFront."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class no válida."
  }
}

variable "enable_ipv6" {
  description = "IPv6 en el borde de CloudFront."
  type        = bool
  default     = true
}

variable "waf_auth_rate_limit" {
  description = "Peticiones a /auth/* por IP del visitante en 5 minutos antes de bloquear (WAF)."
  type        = number
  default     = 100

  validation {
    condition     = var.waf_auth_rate_limit >= 10 && var.waf_auth_rate_limit <= 2000000000
    error_message = "waf_auth_rate_limit debe ser >= 10 (mínimo de WAF)."
  }
}

variable "waf_global_rate_limit" {
  description = "Peticiones totales por IP del visitante en 5 minutos antes de bloquear (WAF)."
  type        = number
  default     = 1000

  validation {
    condition     = var.waf_global_rate_limit >= 10 && var.waf_global_rate_limit <= 2000000000
    error_message = "waf_global_rate_limit debe ser >= 10 (mínimo de WAF)."
  }
}

variable "trust_proxy" {
  description = <<-EOT
    TRUST_PROXY de los listeners públicos (AWS-11, ADR-AWS-04 y ADR-AWS-05 D-AWS-05-09). El valor definitivo
    depende de la prueba P10 (cadena real CloudFront → ALB → ECS). Opciones:
      "false"        (por defecto, seguro: no confía en X-Forwarded-For; los límites por IP de la aplicación
                      ven la IP del ALB y actúan de forma global; WAF sigue limitando por IP real)
      "2"            (dos saltos de confianza: CloudFront y ALB)
      "10.20.0.0/16" (CIDR de la VPC; válido solo si el ALB ve como origen IP privadas de la VPC)
    Nunca "true" (lo rechaza también la aplicación).
  EOT
  type        = string
  default     = "false"

  validation {
    condition = (
      var.trust_proxy == "false" ||
      can(regex("^([1-9]|10)$", var.trust_proxy)) ||
      alltrue([for entry in split(",", var.trust_proxy) : can(cidrnetmask(trimspace(entry))) || can(cidrnetmask("${trimspace(entry)}/32"))])
    )
    error_message = "trust_proxy debe ser \"false\", un número de saltos de 1 a 10 o una lista de IP/CIDR IPv4. \"true\" no está permitido."
  }
}

# ---------------------------------------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------------------------------------
variable "db_engine_version" {
  description = "Versión de PostgreSQL en RDS (mayor; RDS elige la menor por defecto)."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.db_engine_version))
    error_message = "El proyecto usa PostgreSQL 16 (compose: postgres:16.6-alpine)."
  }
}

variable "db_instance_class" {
  description = "Clase de instancia RDS (AD-06)."
  type        = string
  default     = "db.t4g.micro"

  validation {
    condition     = can(regex("^db\\.", var.db_instance_class))
    error_message = "db_instance_class debe empezar por db."
  }
}

variable "db_name" {
  description = "Nombre de la base (compose: POSTGRES_DB=spectra_shop)."
  type        = string
  default     = "spectra_shop"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.db_name))
    error_message = "db_name no válido."
  }
}

variable "db_master_username" {
  description = "Usuario maestro de RDS (no superusuario; solo db-provision y db-finalize)."
  type        = string
  default     = "spectra_admin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,15}$", var.db_master_username)) && !contains(["postgres", "rdsadmin", "admin"], var.db_master_username)
    error_message = "db_master_username no válido o reservado."
  }
}

variable "db_allocated_storage_gb" {
  description = "Almacenamiento gp3 inicial (GB)."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage_gb >= 20
    error_message = "gp3 en RDS exige al menos 20 GB."
  }
}

variable "db_max_allocated_storage_gb" {
  description = "Tope del autoescalado de almacenamiento (GB). Igual al inicial = sin autoescalado."
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "Retención de copias automáticas (días)."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days debe estar entre 1 y 35 (0 desactivaría las copias)."
  }
}

variable "db_deletion_protection" {
  description = "Protección contra borrado de RDS. Destruir el laboratorio exige ponerla en false con autorización."
  type        = bool
  default     = true
}

variable "db_ca_cert_identifier" {
  description = "CA del certificado del servidor RDS."
  type        = string
  default     = "rds-ca-rsa2048-g1"
}

variable "db_apply_immediately" {
  description = "Aplicar cambios de RDS de inmediato."
  type        = bool
  default     = false
}

variable "db_connection_limit" {
  description = "connection_limit de Prisma por proceso (AWS-22)."
  type        = number
  default     = 5

  validation {
    condition     = var.db_connection_limit >= 1 && var.db_connection_limit <= 20
    error_message = "db_connection_limit debe estar entre 1 y 20."
  }
}

# ---------------------------------------------------------------------------------------------------------
# Secretos y claves
# ---------------------------------------------------------------------------------------------------------
variable "secret_versions" {
  description = "Versión write-only por secreto. Incrementar una entrada regenera y reescribe ese valor (rotación). Claves: db/<servicio>-<migrator|app>, internal-token, inventory-token, synthetic-admin."
  type        = map(number)
  default     = {}

  validation {
    condition     = alltrue([for v in values(var.secret_versions) : v >= 1 && floor(v) == v])
    error_message = "Las versiones deben ser enteros >= 1."
  }
}

variable "secret_recovery_window_days" {
  description = "Ventana de recuperación de los secretos al destruir (7-29). lab_cycle_id evita conflictos de nombre sin reducir esta protección."
  type        = number
  default     = 7

  validation {
    condition     = var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 29
    error_message = "secret_recovery_window_days debe estar entre 7 y 29; se reserva al menos un día adicional para la ventana KMS."
  }
}

variable "kms_deletion_window_days" {
  description = "Ventana de borrado programado de las claves KMS (7-30), al menos un día mayor que la recuperación de los secretos cifrados."
  type        = number
  default     = 14

  validation {
    condition = (
      var.kms_deletion_window_days >= 7 &&
      var.kms_deletion_window_days <= 30 &&
      var.kms_deletion_window_days >= var.secret_recovery_window_days + 1
    )
    error_message = "kms_deletion_window_days debe estar entre 7 y 30 y ser al menos un día mayor que secret_recovery_window_days."
  }
}

variable "synthetic_admin_email" {
  description = "Correo FICTICIO del ADMIN sintético (p. ej. admin@spectra.test); null = sin ADMIN sintético."
  type        = string
  default     = null

  validation {
    condition     = var.synthetic_admin_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", var.synthetic_admin_email))
    error_message = "synthetic_admin_email no es un correo válido."
  }
}

# ---------------------------------------------------------------------------------------------------------
# Cómputo
# ---------------------------------------------------------------------------------------------------------
variable "image_tag" {
  description = "SHA completo (40 hex) del commit de main publicado en ECR por PR-6. Los servicios usan <sha>; las migraciones, <sha>-migrate."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag debe ser el SHA completo del commit (40 hex en minúsculas); nunca latest."
  }
}

variable "cpu_architecture" {
  description = "Arquitectura de Fargate; debe coincidir con la plataforma de las imágenes (AWS-09, decisión de PR-6)."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture debe ser X86_64 o ARM64."
  }
}

variable "service_desired_count" {
  description = "Tareas por servicio. 0 en el primer apply (antes de provision/migrate/finalize); 1 después."
  type        = number
  default     = 0

  validation {
    condition     = var.service_desired_count >= 0 && var.service_desired_count <= 2
    error_message = "service_desired_count debe estar entre 0 y 2 en el laboratorio."
  }
}

variable "service_sizes" {
  description = "CPU y memoria por servicio (AWS-23; validar con carga)."
  type = map(object({
    cpu    = number
    memory = number
  }))
  default = {
    identity = { cpu = 512, memory = 1024 }
    catalog  = { cpu = 256, memory = 512 }
    commerce = { cpu = 256, memory = 512 }
    audit    = { cpu = 256, memory = 512 }
  }

  validation {
    condition     = toset(keys(var.service_sizes)) == toset(["identity", "catalog", "commerce", "audit"])
    error_message = "service_sizes debe definir identity, catalog, commerce y audit."
  }
}

variable "ops_size" {
  description = "CPU y memoria de las tareas de operación."
  type = object({
    cpu    = number
    memory = number
  })
  default = { cpu = 256, memory = 512 }
}

variable "readonly_root_filesystem" {
  description = "Raíz de solo lectura en los servicios (AWS-24). Verificar en P1; si una tarea falla por escritura en disco, documentarlo antes de desactivarlo."
  type        = bool
  default     = true
}

variable "container_insights" {
  description = "Container Insights (métricas por tarea; con costo)."
  type        = bool
  default     = false
}

variable "catalog_seed_demo_products" {
  description = "catalog-migrate siembra los productos de demostración (AWS-25; necesarios para la colección Postman E2E)."
  type        = bool
  default     = true
}

variable "spa_bucket_force_destroy" {
  description = "Permite destruir el bucket de la SPA con objetos."
  type        = bool
  default     = false
}

variable "alb_deletion_protection" {
  description = "Protección contra borrado del ALB."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------------------------------------
# Observabilidad y costos
# ---------------------------------------------------------------------------------------------------------
variable "log_retention_days" {
  description = "Retención de los logs (días; valores admitidos por CloudWatch)."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days debe ser un valor admitido por CloudWatch Logs (1-365)."
  }
}

variable "alarm_email" {
  description = "Correo de las alarmas (no se versiona; en terraform.tfvars). null = sin suscripción."
  type        = string
  default     = null
}

variable "alb_5xx_threshold" {
  description = "Respuestas 5xx en 5 minutos que disparan la alarma del ALB."
  type        = number
  default     = 5
}

variable "budget_limit_usd" {
  description = "Límite mensual del presupuesto. Con 50 y avisos al 50 % y 100 % se reproducen las alertas de 25 y 50 USD del plan."
  type        = number
  default     = 50
}

variable "budget_alert_percentages" {
  description = "Porcentajes del límite que generan aviso por gasto real."
  type        = list(number)
  default     = [50, 100]
}

variable "budget_emails" {
  description = "Destinatarios de AWS Budgets (no se versionan). Lista vacía = sin presupuesto (no recomendado)."
  type        = list(string)
  default     = []
}
