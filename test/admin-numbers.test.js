const test = require('node:test');
const assert = require('node:assert/strict');
const { canPublishToChannel, isAdminSender, parseAdminNumbers } = require('../lib/admin-numbers');

test('normalise et déduplique la liste d’administrateurs', () => {
  assert.deepEqual(
    parseAdminNumbers(' +237 677 152 300,237698877771,237677152300 '),
    ['237677152300', '237698877771'],
  );
});

test('ignore les entrées vides ou invalides', () => {
  assert.deepEqual(parseAdminNumbers('abc,,123,237677152300'), ['237677152300']);
});

test('autorise le compte lié de la liste admin si Baileys ne renvoie aucun rôle', () => {
  assert.equal(canPublishToChannel('', '237698877771', ['237677152300', '237698877771']), true);
  assert.equal(canPublishToChannel('', '237699000000', ['237677152300', '237698877771']), false);
});

test('respecte les rôles explicites de Baileys', () => {
  assert.equal(canPublishToChannel('ADMIN', '237699000000', []), true);
  assert.equal(canPublishToChannel('OWNER', '237699000000', []), true);
  assert.equal(canPublishToChannel('SUBSCRIBER', '237698877771', ['237698877771']), false);
});

test('reconnaît un admin @lid grâce au PN alternatif fourni par Baileys', () => {
  assert.equal(
    isAdminSender(['87422981237654@lid', '237677152300@s.whatsapp.net'], ['237677152300', '237698877771']),
    true,
  );
  assert.equal(isAdminSender('87422981237654@lid', ['237677152300', '237698877771']), false);
});

test('n’autorise pas un identifiant de groupe comme numéro admin', () => {
  assert.equal(isAdminSender('237677152300-123456@g.us', ['237677152300']), false);
});
