import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBundles } from '../bundles.mjs';

const bundles = [
  { name: 'base', required: true, description: 'Base bundle' },
  { name: 'handler', required: false, description: 'Handler bundle' },
];

test('selectBundles returns required bundle when no input', async () => {
  const selected = await selectBundles({
    bundles,
    requestedNames: [],
    interactive: false,
  });

  assert.deepEqual(selected.map((bundle) => bundle.name), ['base']);
});

test('selectBundles honours explicit names', async () => {
  const selected = await selectBundles({
    bundles,
    requestedNames: ['handler'],
    interactive: false,
  });

  assert.deepEqual(selected.map((bundle) => bundle.name), ['base', 'handler']);
});

test('selectBundles expands "all" shortcut', async () => {
  const selected = await selectBundles({
    bundles,
    requestedNames: ['all'],
    interactive: false,
  });

  assert.deepEqual(selected.map((bundle) => bundle.name), ['base', 'handler']);
});

test('selectBundles rejects unknown bundles', async () => {
  await assert.rejects(
    () =>
      selectBundles({
        bundles,
        requestedNames: ['unknown'],
        interactive: false,
      }),
    /Unknown bundle/,
  );
});
