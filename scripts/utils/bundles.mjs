import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

const normaliseName = (value) => String(value).toLowerCase();

export const loadManifest = async (manifestPath) => {
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);

  if (!Array.isArray(manifest?.bundles)) {
    throw new Error(`Invalid manifest format: ${manifestPath}`);
  }

  return manifest;
};

export const selectBundles = async ({
  bundles,
  requestedNames = [],
  input,
  output,
  interactive = true,
}) => {
  const requiredBundles = bundles.filter((bundle) => bundle.required);
  const optionalBundles = bundles.filter((bundle) => !bundle.required);

  const requested = new Set(requestedNames.map(normaliseName));

  if (requested.has('all')) {
    optionalBundles.forEach((bundle) => requested.add(normaliseName(bundle.name)));
    requested.delete('all');
  }

  const bundleLookup = new Map(
    bundles.map((bundle) => [normaliseName(bundle.name), bundle]),
  );

  const unknownSelection = [...requested].filter(
    (name) => !bundleLookup.has(normaliseName(name)),
  );

  if (unknownSelection.length > 0) {
    throw new Error(
      `Unknown bundle(s): ${unknownSelection.join(
        ', ',
      )}. Run with --help for available bundles.`,
    );
  }

  let selectedOptional = [...requested]
    .map((name) => bundleLookup.get(normaliseName(name)))
    .filter((bundle) => bundle && !bundle.required);

  const shouldPrompt =
    interactive &&
    selectedOptional.length === 0 &&
    requested.size === 0 &&
    optionalBundles.length > 0 &&
    input?.isTTY &&
    output?.isTTY;

  if (shouldPrompt) {
    const rl = createInterface({ input, output });
    const optionsList = optionalBundles
      .map(
        (bundle, index) => `${index + 1}. ${bundle.name} — ${bundle.description}`,
      )
      .join('\n');

    const answer = await rl.question(
      [
        'Select optional bundles (comma-separated numbers, leave blank for none):',
        optionsList,
        '> ',
      ].join('\n'),
    );
    rl.close();

    const indices = answer
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((num) => Number.isInteger(num) && num > 0);

    selectedOptional = indices
      .map((index) => optionalBundles[index - 1])
      .filter(Boolean);
  }

  const selectedBundleNames = new Set(
    [...requiredBundles, ...selectedOptional].map((bundle) => bundle.name),
  );

  return bundles.filter((bundle) => selectedBundleNames.has(bundle.name));
};

