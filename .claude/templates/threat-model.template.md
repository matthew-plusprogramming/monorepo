# Threat Model: <Feature Name>

**PRD**: .claude/prds/<prd-id>.md
**Date**: <ISO date>

## System Overview

<Brief description of the feature and its security boundaries>

## Trust Boundaries

```
+------------------+     +------------------+     +------------------+
|  Browser/Client  |<--->|   API Gateway    |<--->|     Backend      |
|   (Untrusted)    |     |      (DMZ)       |     |    (Trusted)     |
+------------------+     +------------------+     +------------------+
                                                          |
                                                          v
                                                 +------------------+
                                                 |     Database     |
                                                 |    (Trusted)     |
                                                 +------------------+
```

## Assets

| Asset            | Sensitivity | Impact if Compromised |
| ---------------- | ----------- | --------------------- |
| User credentials | Critical    | Account takeover      |
| Session tokens   | High        | Impersonation         |
| User data        | Medium-High | Privacy breach        |

## STRIDE Analysis

### Spoofing

| Threat              | Risk   | Mitigation                 |
| ------------------- | ------ | -------------------------- |
| Session hijacking   | High   | Secure cookies, HTTPS only |
| Credential stuffing | Medium | Rate limiting, MFA         |

### Tampering

| Threat               | Risk   | Mitigation             |
| -------------------- | ------ | ---------------------- |
| Request modification | Medium | Input validation, HMAC |
| Token manipulation   | High   | Signed tokens (JWT)    |

### Repudiation

| Threat        | Risk   | Mitigation                  |
| ------------- | ------ | --------------------------- |
| Action denial | Medium | Comprehensive audit logging |

### Information Disclosure

| Threat                   | Risk   | Mitigation             |
| ------------------------ | ------ | ---------------------- |
| Data leakage in logs     | Medium | PII filtering          |
| Error message disclosure | Low    | Generic error messages |

### Denial of Service

| Threat                | Risk   | Mitigation                |
| --------------------- | ------ | ------------------------- |
| Resource exhaustion   | Medium | Rate limiting, quotas     |
| Account lockout abuse | Low    | CAPTCHA, graduated delays |

### Elevation of Privilege

| Threat                | Risk     | Mitigation                       |
| --------------------- | -------- | -------------------------------- |
| Horizontal escalation | High     | Resource-level authz checks      |
| Vertical escalation   | Critical | Role validation, least privilege |

## Attack Scenarios

### Scenario 1: <Name>

**Attack Path**: <Step by step>
**Likelihood**: High/Medium/Low
**Impact**: Critical/High/Medium/Low
**Mitigation**: <Control>

### Scenario 2: <Name>

...

## Security Testing Recommendations

1. [ ] Penetration test: <Focus area>
2. [ ] Fuzzing: <Input targets>
3. [ ] Auth bypass testing: <Endpoints>
4. [ ] Rate limit validation: <Endpoints>
