output "arn" {
  description = "ARN del ALB (origen del VPC origin de CloudFront)."
  value       = aws_lb.this.arn
}

output "arn_suffix" {
  description = "Sufijo del ARN (dimensión de las métricas)."
  value       = aws_lb.this.arn_suffix
}

output "dns_name" {
  description = "Nombre DNS interno del ALB."
  value       = aws_lb.this.dns_name
}

output "target_group_arns" {
  description = "ARN del target group de cada servicio."
  value       = { for name, tg in aws_lb_target_group.service : name => tg.arn }
}

output "target_group_arn_suffixes" {
  description = "Sufijo del ARN de cada target group (métricas)."
  value       = { for name, tg in aws_lb_target_group.service : name => tg.arn_suffix }
}

output "listener_arn" {
  description = "ARN del listener HTTP."
  value       = aws_lb_listener.http.arn
}
