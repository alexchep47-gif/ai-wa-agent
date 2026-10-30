const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAdminNumbers } = require('../lib/admin-numbers');

test('normalise et déduplique la liste d’administrateurs', () => {
  assert.deepEqual(
    parseAdminNumbers(' +237 677 152 300,237698877771,237677152300 '),
    ['237677152300', '237698877771'],
  );
});

test('ignore les entrées vides ou invalides', () => {
  assert.deepEqual(parseAdminNumbers('abc,,123,237677152300'), ['237677152300']);
});
