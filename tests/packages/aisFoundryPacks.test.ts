import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const source = readFileSync("modules/ais-foundry-v13/runtime/packs.js", "utf8");
function realm() {
  const context = vm.createContext({});
  vm.runInContext(
    source +
      `
    let catalogueAllowed = true;
    const rpcPacks = [];
    class Collection extends Map {
      constructor(rows=[]) { super(rows.map(row=>[row._id ?? row.id,row])); }
    }
    class Document { constructor(data) { Object.assign(this,data); } get id() { return this._id; } }
    const { CompendiumCollection, FoundryCompendiumCollection, parseFoundryPackText, resolveCompendiumReference } = __aisFoundryPacks.install({
      Collection, Document, documentClasses: { Item: Document }, foundryId:'pf1',
      clone: (v)=>JSON.parse(JSON.stringify(v)), warn: ()=>{},
      getProperty: (obj,path)=>path.split('.').reduce((v,p)=>v?.[p],obj),
      setProperty: (obj,path,value)=>{ obj[path]=value; },
      AIS: { compendium: {
        index: async()=>[{entryId:'fireball',name:'Fireball',type:'spell'}],
        get: async(packId)=>{ rpcPacks.push(packId); if (!catalogueAllowed) throw new Error('denied'); return {data:{_id:'fireball',name:'Fireball',system:{level:3}}}; },
      } },
    });
    const pack = new CompendiumCollection({id:'pf1/spells.json', name:'Spells',type:'Item'});
  `,
    context,
  );
  return (code: string) => vm.runInContext(code, context) as unknown;
}
describe("Foundry compendium indexes", () => {
  test("world pack exposes an empty synchronous index before hydration", () => {
    expect(realm()("pack.index.size")).toBe(0);
  });
  test.each(["{}", "{fields:['system.level']}"])(
    "hydration %s maintains stable, ID-keyed index",
    async (options) => {
      expect(
        await realm()(`(async()=>{
      const index = pack.index;
      await pack.getIndex(${options});
      return index === pack.index && index.size === 1 && index.get('fireball').name === 'Fireball';
    })()`),
      ).toBe(true);
    },
  );
  test("distribution index contains entries, not [id,entry] arrays", () => {
    expect(
      realm()(`new FoundryCompendiumCollection({name:'spells',type:'Item'},
      [{_id:'fireball',name:'Fireball'}]).index.get('fireball').name`),
    ).toBe("Fireball");
  });
  test("fields-requesting hydration updates distribution index", async () => {
    expect(
      await realm()(`(async()=>{
      const pack = new FoundryCompendiumCollection({name:'spells',type:'Item'},
        [{_id:'fireball',name:'Fireball',level:3}]);
      const index = pack.index;
      await pack.getIndex({fields:['level']});
      return index.get('fireball').level;
    })()`),
    ).toBe(3);
  });
});

test("distribution parser preserves system data in JSON/NDJSON rather than synthesizing metadata", () => {
  const run = realm();
  expect(
    run(
      `parseFoundryPackText('{"_id":"fireball","system":{"level":3}}')[0].system.level`,
    ),
  ).toBe(3);
  expect(
    run(
      `parseFoundryPackText('_id: abcdefgh12345678\\nname: Fireball').length`,
    ),
  ).toBe(0);
});
test("compendium UUID resolution preserves dotted world file names and optional document types", () => {
  const run = realm();
  expect(
    run(`resolveCompendiumReference('Compendium.pf1/packs/spells.json.fireball',
    new Map([['pf1/packs/spells.json',pack]])).entryId`),
  ).toBe("fireball");
  expect(
    run(`resolveCompendiumReference('Compendium.pf1/packs/spells.json.Item.fireball',
    new Map([['pf1/packs/spells.json',pack]])).entryId`),
  ).toBe("fireball");
  expect(
    run(
      `resolveCompendiumReference('Compendium.unknown.Item.fireball', new Map())`,
    ),
  ).toBeNull();
});

test("world and distribution hydration respect getter-only Document.id and cache identity", async () => {
  const run = realm();
  expect(await run(`(async () => {
    const world = await pack.getDocument('fireball');
    const own = new FoundryCompendiumCollection({name:'spells',type:'Item'}, [{_id:'fireball',name:'Fireball'}]);
    const doc = await own.getDocument('fireball');
    return world.id === 'fireball' && doc.id === 'fireball' && await own.getDocument('fireball') === doc && own.getName('Fireball') === doc;
  })()`)).toBe(true);
});


test("catalogue aliases route through canonical RPC IDs and cached documents do not bypass revocation", async () => {
  const run = realm();
  expect(await run(`(async () => {
    const shared = new CompendiumCollection({ id: 'content/packs/spells.db', collectionId: 'content.spells', packageId: 'content', packageType: 'module', name: 'Spells', type: 'items' });
    const first = await shared.getDocument('fireball');
    const again = await shared.getDocument('fireball');
    if (shared.id !== 'content.spells' || first !== again || rpcPacks.some(p => p !== 'content/packs/spells.db')) return false;
    catalogueAllowed = false;
    return await shared.getDocument('fireball') === null;
  })()`)).toBe(true);
});
