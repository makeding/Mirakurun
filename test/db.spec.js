const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const db = require("../lib/Mirakurun/db");

function createServices(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 32391 * 100000 + i,
    serviceId: i,
    networkId: 32391,
    type: 1,
    name: `サービス${i}`,
    channel: { type: "GR", channel: "27" },
    logoData: "a".repeat(2000)
  }));
}

describe("[db.spec] db.ts: saveServices() / loadServices()", () => {
  let tmpDir;
  let originalPath;

  before(() => {
    // Exact owned path, 16 MiB total budget; removed before reuse and at teardown.
    tmpDir = path.join(os.tmpdir(), "mirakurun-upstream-db-tests");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalPath = process.env.SERVICES_DB_PATH;
  });

  after(() => {
    if (originalPath === undefined) {
      delete process.env.SERVICES_DB_PATH;
    } else {
      process.env.SERVICES_DB_PATH = originalPath;
    }
    const bytes = fs.readdirSync(tmpDir, { recursive: true }).reduce((sum, name) => {
      const stat = fs.statSync(path.join(tmpDir, name));
      return sum + (stat.isFile() ? stat.size : 0);
    }, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.ok(bytes < 16 * 1024 * 1024, "JSON store test-output budget");
    assert.equal(fs.existsSync(tmpDir), false);
  });

  it("writes the same JSON as JSON.stringify and loads it back", async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "services.json");
    const services = createServices(500); // 書き出しの 1 回分より大きいデータ

    await db.saveServices(services, "integrity-a");

    const json = fs.readFileSync(process.env.SERVICES_DB_PATH, "utf8");
    assert.strictEqual(json, JSON.stringify([{ __integrity__: "integrity-a" }, ...services]));
    assert.deepStrictEqual(await db.loadServices("integrity-a"), services);
    assert.deepStrictEqual(await db.loadServices("integrity-a", true), services);
    assert.deepStrictEqual(await db.loadServices("integrity-b"), []);
  });

  it("does not modify the given array", async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "services.json");
    const services = createServices(3);

    await db.saveServices(services, "integrity-a");

    assert.strictEqual(services.length, 3);
    assert.strictEqual(services[0].serviceId, 0);
  });

  it("overwrites a larger existing file", async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "services.json");

    await db.saveServices(createServices(100), "integrity-a");
    await db.saveServices(createServices(1), "integrity-a");

    assert.deepStrictEqual(await db.loadServices("integrity-a"), createServices(1));
  });

  it("saves an empty array", async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "services.json");

    await db.saveServices([], "integrity-a");

    assert.strictEqual(fs.readFileSync(process.env.SERVICES_DB_PATH, "utf8"), "[{\"__integrity__\":\"integrity-a\"}]");
    assert.deepStrictEqual(await db.loadServices("integrity-a"), []);
  });

  it("keeps the existing file when saving fails", async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "services.json");
    const services = createServices(500);
    await db.saveServices(services, "integrity-a");
    const before = fs.readFileSync(process.env.SERVICES_DB_PATH);

    // JSON.stringify が途中のサービスで失敗する
    const broken = createServices(500);
    broken[400].extra = 1n;
    await db.saveServices(broken, "integrity-a");

    assert.ok(fs.readFileSync(process.env.SERVICES_DB_PATH).equals(before));
    assert.strictEqual(fs.existsSync(`${process.env.SERVICES_DB_PATH}.tmp`), false);
    assert.deepStrictEqual(await db.loadServices("integrity-a"), services);
  });

  it("creates the missing directory", { timeout: 5000 }, async () => {
    process.env.SERVICES_DB_PATH = path.join(tmpDir, "missing", "dir", "services.json");
    const services = createServices(2);

    await db.saveServices(services, "integrity-a");

    assert.deepStrictEqual(await db.loadServices("integrity-a"), services);
  });
});
