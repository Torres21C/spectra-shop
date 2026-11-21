output "log_group_names" {
  description = "Log group de cada carga de trabajo."
  value       = { for name, lg in aws_cloudwatch_log_group.workload : name => lg.name }
}

output "log_group_arns" {
  description = "ARN de cada log group."
  value       = { for name, lg in aws_cloudwatch_log_group.workload : name => lg.arn }
}

output "alarm_topic_arn" {
  description = "Tema SNS de las alarmas."
  value       = aws_sns_topic.alarms.arn
}

output "alarm_names" {
  description = "Nombres de las alarmas."
  value = concat(
    [for a in aws_cloudwatch_metric_alarm.event : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.alb_5xx : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.unhealthy_targets : a.alarm_name],
    [aws_cloudwatch_metric_alarm.rds_cpu.alarm_name, aws_cloudwatch_metric_alarm.rds_storage.alarm_name],
  )
}
