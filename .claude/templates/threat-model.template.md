# Threat Model: {FEATURE_NAME}

## Scope

- **Component**: {component being modeled}
- **Data Flows**: {what data moves through this component}
- **Trust Boundaries**: {where trust levels change}

---

## Assets

| Asset  | Sensitivity       | Description  |
| ------ | ----------------- | ------------ |
| {name} | {high/medium/low} | {what it is} |

---

## Threats

### {THREAT_ID}: {Threat Name}

- **Category**: {STRIDE category: Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege}
- **Description**: {how the threat manifests}
- **Likelihood**: {high|medium|low}
- **Impact**: {high|medium|low}
- **Risk**: {critical|high|medium|low} (likelihood x impact)

#### Attack Vector

{How an attacker would exploit this}

#### Mitigations

- [ ] {Mitigation 1}
- [ ] {Mitigation 2}

---

## Assumptions

- {Security assumptions made}

---

## Out of Scope

- {What this model explicitly does not cover}
