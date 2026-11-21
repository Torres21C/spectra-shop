# AWS WAF de ámbito CLOUDFRONT (AWS-11, AWS-15; plan P10). Debe crearse en us-east-1. El throttler de los
# servicios es por réplica y en memoria: las reglas rate-based por IP del visitante son la protección
# principal en el borde.

locals {
  managed_rule_groups = [
    { name = "AWSManagedRulesAmazonIpReputationList", priority = 10 },
    { name = "AWSManagedRulesKnownBadInputsRuleSet", priority = 20 },
    { name = "AWSManagedRulesCommonRuleSet", priority = 30 },
    { name = "AWSManagedRulesSQLiRuleSet", priority = 40 },
  ]
}

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name_prefix}-edge"
  description = "SPECTRA lab: reglas administradas y limites por IP del visitante"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Límite estricto para /auth/* (registro, login, refresh): complementa los límites por IP de Identity.
  rule {
    name     = "rate-limit-auth"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_auth_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/auth/"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-auth"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-global"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_global_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-global"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.managed_rule_groups

    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-${rule.value.name}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-edge"
    sampled_requests_enabled   = true
  }
}

# Logs de WAF (el nombre debe empezar por aws-waf-logs-). Se ocultan las cabeceras con credenciales:
# cookies de sesión (__Host-spectra-*), token CSRF y Authorization.
resource "aws_cloudwatch_log_group" "waf" {
  # checkov:skip=CKV_AWS_338:Retención de 30 días en el laboratorio (plan §5, paso 8; costo). Exportar a la bóveda las evidencias necesarias antes de que expiren.
  name              = "aws-waf-logs-${var.name_prefix}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "x-csrf-token"
    }
  }

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}
