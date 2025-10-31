import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSlugVariants,
  slugToSegments,
  toCamelCase,
  toConstantCase,
  toPascalCase,
} from '../naming.mjs';

test('slug helpers normalise segments', () => {
  assert.deepEqual(slugToSegments('User-Profile_service'), [
    'user',
    'profile',
    'service',
  ]);
});

test('case helpers derive expected values', () => {
  assert.equal(toPascalCase('user-profile'), 'UserProfile');
  assert.equal(toCamelCase('user-profile'), 'userProfile');
  assert.equal(toConstantCase('user-profile'), 'USER_PROFILE');
});

test('buildSlugVariants aggregates casing forms', () => {
  assert.deepEqual(buildSlugVariants('audit-log'), {
    slug: 'audit-log',
    pascalCase: 'AuditLog',
    camelCase: 'auditLog',
    constantCase: 'AUDIT_LOG',
  });
});
