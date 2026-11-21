# Definición única de cada carga de trabajo: imagen, puertos, variables y secretos. Las task definitions Y
# los roles de ejecución se generan desde aquí, de modo que cada rol solo puede leer exactamente los secretos
# que su task definition inyecta (sin listas paralelas que puedan divergir).
#
# Variables tomadas del código real (`main` a0f8052): identity.config.ts, admin.config.ts,
# inventory.config.ts, commerce.config.ts, audit config.ts, identity-public-key.ts, trust-proxy.ts y
# compose.yaml. Los valores no secretos van en `environment`; los secretos, por `secrets[].valueFrom`.

locals {
  # Cloud Map (AWS-06): espacio privado; solo los servicios con listener interno se registran.
  identity_internal_url = "http://identity.${var.service_discovery_namespace}:3101"
  catalog_internal_url  = "http://catalog.${var.service_discovery_namespace}:3102"
  audit_internal_url    = "http://audit.${var.service_discovery_namespace}:3104"

  # Variables comunes a los listeners públicos detrás de CloudFront y del ALB.
  edge_environment = {
    COOKIE_SECURE = "true"
    CORS_ORIGINS  = var.public_origin
    # AWS-11 / ADR-AWS-05 D-AWS-05-09: configurable; el valor definitivo sale de la prueba P10.
    TRUST_PROXY = var.trust_proxy
  }

  db = var.db_role_secret_arns

  services = {
    identity = {
      repository    = "identity-service"
      port          = 3001
      internal_port = 3101
      discovery     = true
      task_role     = true
      environment = merge(local.edge_environment, {
        PORT                          = "3001"
        INTERNAL_PORT                 = "3101"
        IDENTITY_ALLOW_EPHEMERAL_KEYS = "false"
        # AD-08 / ADR-AWS-02: firma con KMS; la clave privada no sale de KMS.
        IDENTITY_JWT_SIGNER = "kms"
        IDENTITY_KMS_KEY_ID = var.jwt_key_arn
        AWS_REGION          = var.region
      })
      secrets = {
        IDENTITY_DATABASE_URL   = { arn = local.db["identity-app"], key = "url" }
        SPECTRA_INTERNAL_TOKENS = { arn = var.internal_token_secret_arn, key = null }
      }
    }

    catalog = {
      repository    = "catalog-service"
      port          = 3002
      internal_port = 3102
      discovery     = true
      task_role     = false
      environment = merge(local.edge_environment, {
        PORT                    = "3002"
        INTERNAL_PORT           = "3102"
        IDENTITY_INTERNAL_URL   = local.identity_internal_url
        AUDIT_INTERNAL_URL      = local.audit_internal_url
        IDENTITY_PUBLIC_KEY_PEM = var.jwt_public_key_pem
      })
      secrets = {
        DATABASE_URL             = { arn = local.db["catalog-app"], key = "url" }
        SPECTRA_INTERNAL_TOKENS  = { arn = var.internal_token_secret_arn, key = null }
        SPECTRA_INTERNAL_TOKEN   = { arn = var.internal_token_secret_arn, key = null }
        CATALOG_INVENTORY_TOKENS = { arn = var.inventory_token_secret_arn, key = null }
      }
    }

    commerce = {
      repository    = "commerce-service"
      port          = 3003
      internal_port = null
      discovery     = false
      task_role     = false
      environment = merge(local.edge_environment, {
        PORT                    = "3003"
        IDENTITY_INTERNAL_URL   = local.identity_internal_url
        CATALOG_INTERNAL_URL    = local.catalog_internal_url
        IDENTITY_PUBLIC_KEY_PEM = var.jwt_public_key_pem
      })
      secrets = {
        COMMERCE_DATABASE_URL   = { arn = local.db["commerce-app"], key = "url" }
        SPECTRA_INTERNAL_TOKEN  = { arn = var.internal_token_secret_arn, key = null }
        CATALOG_INVENTORY_TOKEN = { arn = var.inventory_token_secret_arn, key = null }
      }
    }

    audit = {
      repository    = "audit-service"
      port          = 3004
      internal_port = 3104
      discovery     = true
      task_role     = false
      environment = merge(local.edge_environment, {
        PORT                    = "3004"
        INTERNAL_PORT           = "3104"
        IDENTITY_INTERNAL_URL   = local.identity_internal_url
        IDENTITY_PUBLIC_KEY_PEM = var.jwt_public_key_pem
      })
      secrets = {
        AUDIT_DATABASE_URL      = { arn = local.db["audit-app"], key = "url" }
        SPECTRA_INTERNAL_TOKEN  = { arn = var.internal_token_secret_arn, key = null }
        SPECTRA_INTERNAL_TOKENS = { arn = var.internal_token_secret_arn, key = null }
      }
    }
  }

  # -------------------------------------------------------------------------------------------------------
  # Tareas de un solo uso (plan §11): se ejecutan con `aws ecs run-task`, en serie y a mano (PR-7). Terraform
  # solo las DEFINE: ninguna se lanza al aplicar ni al arrancar un servicio (DT-09).
  # -------------------------------------------------------------------------------------------------------
  pg_environment = {
    PGHOST     = var.db_address
    PGPORT     = tostring(var.db_port)
    PGDATABASE = var.db_name
    # C6 (ADR-AWS-05 D-AWS-05-07): cifra el transporte, NO verifica el certificado (no equivale a verify-full).
    PGSSLMODE = "require"
  }

  master_secrets = {
    PGUSER     = { arn = var.master_secret_arn, key = "username" }
    PGPASSWORD = { arn = var.master_secret_arn, key = "password" }
  }

  role_password_secrets = {
    for role in keys(local.db) :
    "SPECTRA_${upper(replace(role, "-", "_"))}_PASSWORD" => { arn = local.db[role], key = "password" }
  }

  # Mismas órdenes que los jobs de compose.yaml (imagen `migrate`, ADR-AWS-03).
  prisma_migrate = "./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --file prisma/runtime-grants.sql"

  synthetic_admin_secrets = var.synthetic_admin_secret_arn == null ? {} : {
    SYNTHETIC_ADMIN_EMAIL    = { arn = var.synthetic_admin_secret_arn, key = "email" }
    SYNTHETIC_ADMIN_PASSWORD = { arn = var.synthetic_admin_secret_arn, key = "password" }
  }

  ops = {
    db-provision = {
      repository  = "db-ops"
      image_tag   = var.image_tag
      command     = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/provision/provision-service-roles.sql"]
      environment = local.pg_environment
      secrets     = merge(local.master_secrets, local.role_password_secrets)
    }

    identity-migrate = {
      repository  = "identity-service"
      image_tag   = "${var.image_tag}-migrate"
      command     = ["sh", "-c", "${local.prisma_migrate} && node dist/database/seed.js"]
      environment = {}
      secrets = merge(
        { IDENTITY_DATABASE_URL = { arn = local.db["identity-migrator"], key = "url" } },
        local.synthetic_admin_secrets,
      )
    }

    catalog-migrate = {
      repository = "catalog-service"
      image_tag  = "${var.image_tag}-migrate"
      # AWS-25: el seed de productos de demostración es opcional (solo inserta lo que falta).
      command     = ["sh", "-c", var.catalog_seed_demo_products ? "${local.prisma_migrate} && node dist/database/seed.js" : local.prisma_migrate]
      environment = {}
      secrets = {
        DATABASE_URL = { arn = local.db["catalog-migrator"], key = "url" }
      }
    }

    commerce-migrate = {
      repository  = "commerce-service"
      image_tag   = "${var.image_tag}-migrate"
      command     = ["sh", "-c", local.prisma_migrate]
      environment = {}
      secrets = {
        COMMERCE_DATABASE_URL = { arn = local.db["commerce-migrator"], key = "url" }
      }
    }

    audit-migrate = {
      repository  = "audit-service"
      image_tag   = "${var.image_tag}-migrate"
      command     = ["sh", "-c", local.prisma_migrate]
      environment = {}
      secrets = {
        AUDIT_DATABASE_URL = { arn = local.db["audit-migrator"], key = "url" }
      }
    }

    db-finalize = {
      repository  = "db-ops"
      image_tag   = var.image_tag
      command     = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/provision/finalize-service-roles.sql"]
      environment = local.pg_environment
      secrets     = local.master_secrets
    }
  }

  # Vista común para IAM: repositorio y secretos de cada carga de trabajo.
  workloads = merge(
    { for name, svc in local.services : name => { repository = svc.repository, secrets = svc.secrets } },
    { for name, op in local.ops : name => { repository = op.repository, secrets = op.secrets } },
  )
}
