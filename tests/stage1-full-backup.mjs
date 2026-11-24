import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const pngA = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S5cAAAAASUVORK5CYII=', 'base64');
const pngB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

async function waitReady(page) {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent === '保存領域準備完了', null, { timeout: 15000 });
}
async function dbSnapshot(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('AIClipStudioAssets', 3);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['images', 'assetImageVersions'], 'readonly');
      const images = tx.objectStore('images');
      const history = tx.objectStore('assetImageVersions');
      const a = images.getAll();
      const b = history.getAll();
      tx.oncomplete = () => {
        resolve({
          imageCount: a.result.length,
          imageSizes: a.result.map(x => x.size),
          historyCount: b.result.length,
          historySizes: b.result.map(x => x.blob?.size)
        });
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
}

const browser = await chromium.launch({ headless: true });
try {
  const source = await browser.newContext({ acceptDownloads: true });
  const page = await source.newPage();
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'application/x-tar') window.__aiclipTestTarBlob = blob;
      return original(blob);
    };
  });
  page.on('dialog', dialog => dialog.accept());
  await waitReady(page);

  await page.locator('[data-tab="assets"]').click();
  await page.locator('#addAsset').click();
  await page.locator('#assetName').fill('Stage1 test asset');
  await page.locator('#assetImage').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: pngA });
  await page.locator('#saveAsset').click();
  await page.getByText('Stage1 test asset', { exact: true }).waitFor();

  await page.getByRole('button', { name: '編集・画像差し替え' }).click();
  await page.locator('#assetImage').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: pngB });
  await page.locator('#saveAsset').click();
  await page.getByText(/v2/).waitFor();

  const beforeExport = await dbSnapshot(page);
  assert.equal(beforeExport.imageCount, 1, 'expected one current image');
  assert.equal(beforeExport.historyCount, 1, 'expected one replaced-image history record');

  // The full-backup export control is injected into the Projects screen toolbar.
  await page.evaluate(() => tab('projects'));
  await page.locator('#projects').waitFor({ state: 'visible' });
  await page.locator('#exportFullBackup').waitFor({ state: 'visible' });
  await page.locator('#exportFullBackup').click();
  await page.waitForFunction(() => window.__aiclipTestTarBlob instanceof Blob, null, { timeout: 15000 });
  const archiveBase64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await window.__aiclipTestTarBlob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const archive = Buffer.from(archiveBase64, 'base64');
  assert.ok(archive.length >= 1024, 'full backup TAR should contain a valid archive');

  const restoredContext = await browser.newContext();
  const restored = await restoredContext.newPage();
  let restoredDialogMessage = '';
  restored.on('dialog', dialog => {
    restoredDialogMessage = dialog.message();
    dialog.accept();
  });
  await waitReady(restored);
  await restored.locator('[data-tab="assets"]').click();
  await restored.locator('#restoreFullBackupFile').setInputFiles({
    name: 'stage1-test.tar', mimeType: 'application/x-tar', buffer: archive
  });
  await restored.waitForFunction(() => document.querySelector('#saveStatus')?.textContent === 'バックアップ復元済み');
  await restored.locator('[data-tab="assets"]').click();
  await restored.getByText('Stage1 test asset', { exact: true }).waitFor({ timeout: 15000 });
  const afterRestore = await dbSnapshot(restored);
  assert.deepEqual(afterRestore, beforeExport, 'restored image and history stores must match the source');
  const restoredProjectData = await restored.evaluate(() => JSON.parse(localStorage.getItem('aiclip_v02')));
  assert.equal(restoredProjectData.assets.length, 1);
  assert.equal(restoredProjectData.assets[0].name, 'Stage1 test asset');

  // Corrupt the first TAR header byte; checksum validation must reject it without changing data.
  const corrupted = Buffer.from(archive);
  corrupted[0] = corrupted[0] === 0x58 ? 0x59 : 0x58;
  restoredDialogMessage = '';
  await restored.locator('#restoreFullBackupFile').setInputFiles({
    name: 'corrupted.tar', mimeType: 'application/x-tar', buffer: corrupted
  });
  await restored.waitForFunction(() => document.querySelector('#saveStatus')?.textContent === 'バックアップ復元済み');
  assert.match(restoredDialogMessage, /チェックサム/);
  const afterRejectedImport = await dbSnapshot(restored);
  assert.deepEqual(afterRejectedImport, afterRestore, 'invalid archive must not mutate IndexedDB');
  const afterRejectedData = await restored.evaluate(() => JSON.parse(localStorage.getItem('aiclip_v02')));
  assert.deepEqual(afterRejectedData, restoredProjectData, 'invalid archive must not mutate localStorage');

  console.log(JSON.stringify({
    result: 'PASS',
    checks: [
      'image upload and replacement',
      'full TAR export',
      'full TAR restore in a clean browser context',
      'current image and history Blob round-trip',
      'corrupt TAR checksum rejected without mutation'
    ],
    beforeExport,
    afterRestore
  }, null, 2));
  await source.close();
  await restoredContext.close();
} finally {
  await browser.close();
}
