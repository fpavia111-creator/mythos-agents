Fictional service config snapshots, table schemas, Terraform state and Kubernetes manifests for demos and tests. Secret values are fake; hosts use example.com; no real accounts, clusters or companies.

- `snapshots/*.json`: three dated config snapshots of a made-up billing API.
- `schema-2026-10-01.csv`, `schema-2026-11-01.csv`: two schema snapshots.
- `terraform/*.tfstate`: two hand-written Terraform state files (v4 layout): a security group opened to everyone, a database made public with deletion protection off and a changed password (sensitive), a bucket removed and an IAM user added.
- `k8s/*.yaml`: two manifest snapshots (Deployment, Service, Secret): privileged container, `latest` image tag, Service changed to LoadBalancer, a changed Secret, reordered env.
- `approved-drift.json`: an approved-drift baseline (schema `approved_drift`) that accepts two of the config changes.
