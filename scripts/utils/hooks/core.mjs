import { join } from 'node:path';

import { registerHook } from '../hooks.mjs';

export const registerCoreHooks = () => {
  registerHook('renderTemplates', 'core.renderTemplates', async (context) => {
    const { selectedBundles, helpers, addReportEntry } = context;

    for (const bundle of selectedBundles) {
      if (!Array.isArray(bundle.templates)) continue;

      for (const templateMeta of bundle.templates) {
        const templateContent = await helpers.readTemplate(
          join('bundles', bundle.name, templateMeta.source),
        );
        const rendered = helpers.applyTokens(templateContent);
        const targetRelative = helpers.applyTokens(templateMeta.target);
        const targetPath = helpers.resolveOutput(targetRelative);

        const writeOutcome = await helpers.writeFile(targetPath, rendered);
        addReportEntry({
          location: helpers.relativeToOutput(targetPath),
          action: writeOutcome.action,
          skipped: Boolean(writeOutcome.skipped),
          bundle: bundle.name,
        });
      }
    }

    return { status: 'ok' };
  });
};
