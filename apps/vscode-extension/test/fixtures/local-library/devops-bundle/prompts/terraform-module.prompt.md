# Terraform Module

Design reusable, maintainable Infrastructure as Code with Terraform.

## Module Structure

```
terraform/
├── main.tf
├── variables.tf
├── outputs.tf
├── versions.tf
└── README.md
```

## Example Module

```hcl
# variables.tf
variable "environment" {
  description = "Environment name"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

# main.tf
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  
  tags = {
    Name        = "${var.environment}-vpc"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# outputs.tf
output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}
```

## Best Practices

- Use remote state (S3 + DynamoDB)
- Implement state locking
- Use workspaces for environments
- Version your modules
- Add comprehensive validation

Infrastructure as Code done right\!
