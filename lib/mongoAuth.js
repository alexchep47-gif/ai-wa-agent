/**
 * Auth state Baileys sauvegardé dans MongoDB (survit aux deploys Render).
 */
const { MongoClient } = require('mongodb');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useMongoAuthState(mongoUri, dbName = 'cmr_wa_bot') {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const coll = client.db(dbName).collection('baileys_auth');
  console.log('[AUTH] MongoDB connecté — session persistante active');

  const write = async (id, data) => {
    await coll.updateOne(
      { _id: id },
      { $set: { data: JSON.stringify(data, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const read = async (id) => {
    const doc = await coll.findOne({ _id: id });
    if (!doc?.data) return null;
    try {
      return JSON.parse(doc.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const remove = async (id) => {
    await coll.deleteOne({ _id: id });
  };

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await read(`${type}-${id}`);
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await write('creds', creds);
    },
    clearSession: async () => {
      await coll.deleteMany({});
      console.log('[AUTH] Session Mongo effacée');
    },
  };
}

module.exports = { useMongoAuthState };
