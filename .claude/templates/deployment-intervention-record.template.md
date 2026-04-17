# Deployment Intervention Record

Fill in all fields below before signing with `git commit -S`.

## Required Fields

- **service**: <!-- service name from deployment manifest -->
- **intervention_timestamp**: <!-- UTC ISO-8601, e.g. 2026-04-15T14:30:00Z -->
- **pre_intervention_env_hash**: <!-- 64-char hex SHA-256 from deployment.expected_env_hash -->
- **post_intervention_env_hash**: <!-- 64-char hex SHA-256 of current env state -->
- **divergence_kind**: <!-- added | removed | changed -->
- **maintainer_rationale**: <!-- >= 50 characters explaining why the env change is intentional -->

## Signing Instructions

1. Save this file with all fields filled in
2. Append a JSON entry to `.claude/audit/deployment-interventions.log`
3. Stage both files: `git add .claude/audit/deployment-interventions.log`
4. Sign the commit: `git commit -S -m "intervention: <service> env divergence acknowledged"`
5. The commit message MUST contain all required fields listed above
6. The signer's GPG/SSH key must match an entry in CODEOWNERS

## After Signing

Run the clear command with the signed record:

```bash
node .claude/scripts/session-checkpoint.mjs record-deployment-clear-failure \
  --service <name> --signed-record <path-to-this-file>
```

Verify the audit chain afterward:

```bash
node .claude/scripts/verify-deployment-audit-chain.mjs
```
