# Config Directory

The `.claude/config/` directory contains YAML configuration files that externalize tunable parameters. This separates **policy from mechanism**: operators and consumer projects can adjust behavior (retention periods, upgrade strategies, architecture thresholds) without editing scripts, agents, or prompts.

## Config Files

### journal-retention.yaml (Ready-to-use)

Defines journal entry retention policies.

| Key                      | Type     | Default                           | Description                                 |
| ------------------------ | -------- | --------------------------------- | ------------------------------------------- |
| `default_retention_days` | integer  | 90                                | Days before standard journal entries expire |
| `permanent_types`        | string[] | `[decision-record, supersession]` | Entry types exempt from expiration          |
| `backup.enabled`         | boolean  | true                              | Enable automatic backups before cleanup     |
| `backup.destination`     | string   | `.claude/journal/backups`         | Backup file location                        |
| `backup.max_backups`     | integer  | 10                                | Maximum backup files retained               |

**Status**: Ready-to-use. Defaults are sensible for most projects. Override `default_retention_days` if your project needs longer or shorter retention.

### agent-upgrade.yaml (Ready-to-use)

Defines Claude CLI version pinning and upgrade strategy.

| Key                                         | Type    | Default     | Description                                            |
| ------------------------------------------- | ------- | ----------- | ------------------------------------------------------ |
| `claude_cli_version`                        | string  | `"latest"`  | Pinned version or `"latest"` to skip checking          |
| `upgrade_policy.strategy`                   | string  | `"rolling"` | `"rolling"` (use latest) or `"pinned"` (enforce exact) |
| `upgrade_policy.allow_minor_mismatch`       | boolean | true        | Accept minor version differences                       |
| `upgrade_policy.allow_patch_mismatch`       | boolean | true        | Accept patch version differences                       |
| `mismatch_behavior.log_warning`             | boolean | true        | Log warning on version mismatch                        |
| `mismatch_behavior.emit_event`              | boolean | true        | Emit event on version mismatch                         |
| `mismatch_behavior.block_on_major_mismatch` | boolean | false       | Block invocation on major version change               |
| `rollback_procedures`                       | object  | --          | Step-by-step rollback instructions                     |

**Status**: Ready-to-use. The rolling strategy with latest version works for most projects. Pin a specific version when stability is critical.

### architecture.yaml (Template with defaults)

Defines thresholds for architecture analysis tools: complexity scoring, debt tracking, deliberation cycles, and atomization limits.

| Section        | Key Fields                                                         | Description                                |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `complexity`   | `threshold`, `warn_at`                                             | Maximum and warning complexity scores      |
| `debt`         | `threshold_per_component`, `severity_weights`                      | Debt scoring limits and weight multipliers |
| `deliberation` | `max_cycles`, `circuit_breaker_limit`                              | Deliberation round limits                  |
| `atomization`  | `max_refinement_iterations`, `investigation_clean_passes_required` | Spec decomposition limits                  |
| `paths`        | `specs`, `config`, `debt_inventory`                                | Standard project directory paths           |

**Status**: Template with sensible defaults. Usable out-of-the-box, but projects should review and customize thresholds for their specific codebase size and complexity profile.

## Customization Guide

### For Consumer Projects

1. **Sync config files** using the metaclaude sync system (they are included in the `core-workflow` bundle)
2. **Review defaults** in each file -- they work for most projects but may need tuning
3. **Edit locally** -- config files are your project's copy; changes do not propagate back to metaclaude
4. **Do not rename files** -- the registry tracks them by path; renaming breaks sync

### Ready-to-use vs. Template

| File                     | Type         | Meaning                                                          |
| ------------------------ | ------------ | ---------------------------------------------------------------- |
| `journal-retention.yaml` | Ready-to-use | Defaults work for all projects; customize only if needed         |
| `agent-upgrade.yaml`     | Ready-to-use | Defaults work for all projects; customize only if needed         |
| `architecture.yaml`      | Template     | Defaults work but are generic; projects should review thresholds |

**Ready-to-use** files have defaults that are appropriate for any project. You can use them without modification.

**Template** files have defaults that work but are intentionally generic. Review the values and adjust for your project's scale and conventions.

### Adding New Config Files

Consumer projects can add their own YAML files to `.claude/config/` for project-specific configuration. The metaclaude config directory only contains project-agnostic files; project-specific configs (like CI pipeline configuration or team-specific workflow patterns) belong in the consumer project's own config directory.
