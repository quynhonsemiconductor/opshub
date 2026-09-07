# deploy/ecs — ECS deploy descriptors

Same contract as [rally](https://github.com/quynhonsemiconductor/rally): opshub's ECS **task definitions are infrastructure-owned** (the `ecs-service` module calls in `infra/modules/stack/main.tf`, shared by both environments), and CI patches only the image tag per deploy (`describe-task-definition` → swap image → `register-task-definition` → `update-service`). No standalone task-def JSON is maintained here.

At the EKS phase (architecture §13.2, trigger-driven) this is replaced by a Helm `chart/` and pull-based ArgoCD CD.
