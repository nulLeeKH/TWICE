import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const registry = () => readJson(path.join(root, 'licensing/third-party.json'));
const fromRoot = file => {
  const result = path.resolve(root, file);
  if (!result.startsWith(root)) throw new Error(`License path escapes the project: ${file}`);
  return result;
};
const allowedDevelopmentLicenses = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0']);
const bundledPackages = new Map();

export function installedInventory() {
  const packages = new Map(), store = path.join(root, 'node_modules/.pnpm');
  for (const folder of fs.readdirSync(store)) {
    const modules = path.join(store, folder, 'node_modules');
    if (!fs.existsSync(modules)) continue;
    for (const name of fs.readdirSync(modules)) {
      const candidates = name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).map(child => path.join(modules, name, child)) : [path.join(modules, name)];
      for (const candidate of candidates) {
        if (fs.lstatSync(candidate).isSymbolicLink() || !fs.existsSync(path.join(candidate, 'package.json'))) continue;
        const pkg = readJson(path.join(candidate, 'package.json'));
        packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license ?? null });
      }
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
}

export function checkLicenses() {
  const data = registry();
  if (readJson(path.join(root, 'package.json')).license !== 'MIT') throw new Error('Project SPDX license and LICENSE must be reviewed together.');
  if (!fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').startsWith('MIT License\n')) throw new Error('Missing project MIT license.');
  for (const [file, expected] of Object.entries(data.licenseFiles)) {
    if (!fs.existsSync(fromRoot(file)) || sha256(fs.readFileSync(fromRoot(file))) !== expected) throw new Error(`Missing or changed license text: ${file}`);
  }
  for (const asset of data.assets) {
    if (sha256(fs.readFileSync(fromRoot(asset.path))) !== asset.sha256) throw new Error(`Vendor asset changed; re-review its provenance and license: ${asset.path}`);
  }
  const actualAssets = [];
  function visit(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (!Object.hasOwn(data.licenseFiles, relative)) actualAssets.push(relative);
      }
    }
  }
  visit(path.join(root, 'public/vendor'));
  for (const file of actualAssets) if (!data.assets.some(asset => asset.path === file)) throw new Error(`Unreviewed vendor asset: ${file}`);
  for (const component of data.components) for (const file of component.licenseFiles) if (!data.licenseFiles[file]) throw new Error(`License text not registered: ${file}`);
  for (const pkg of installedInventory()) if (!allowedDevelopmentLicenses.has(pkg.license)) throw new Error(`Review dependency license before building: ${pkg.name}@${pkg.version} (${pkg.license})`);
  return data;
}

function recordPackage(pkg, data) {
  const registered = data.components.find(component => component.package === pkg.name);
  if (!registered || registered.version !== pkg.version || registered.license !== pkg.license) throw new Error(`Runtime dependency needs license review: ${pkg.name}@${pkg.version} (${pkg.license})`);
  bundledPackages.set(pkg.name, { name: pkg.name, version: pkg.version, license: pkg.license });
}
function packageForModule(id) {
  let folder = path.dirname(id.split('?')[0]);
  while (folder !== path.dirname(folder)) {
    const file = path.join(folder, 'package.json');
    if (fs.existsSync(file)) return readJson(file);
    folder = path.dirname(folder);
  }
  throw new Error(`Cannot identify package for bundled module: ${id}`);
}
/** Checks real emitted modules, including packages pulled in by WXT's generated entrypoints. */
export function licensePlugin() {
  return {
    name: 'twice-third-party-licenses',
    generateBundle(_options, bundle) {
      const data = checkLicenses();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          if (id.includes('node_modules/') && !id.startsWith('\0')) recordPackage(packageForModule(id), data);
          else if (id === '\0vite/modulepreload-polyfill.js' || id === '\0rolldown/runtime.js') {
            const fromWxt = createRequire(require.resolve('wxt'));
            const vitePackage = fromWxt.resolve('vite/package.json');
            recordPackage(readJson(id.includes('rolldown') ? createRequire(vitePackage).resolve('rolldown/package.json') : vitePackage), data);
          }
        }
      }
    },
  };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const packaged = file => file.replace(/^public\//, '');
export function writeLicenseBundle(outDir) {
  const data = checkLicenses();
  fs.mkdirSync(path.join(outDir, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
  const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replaceAll('](public/', '](').replaceAll('](licensing/third-party.json)', '](licenses/components.json)').replaceAll('](licensing/development-dependencies.json)', '](licenses/development-dependencies.json)');
  fs.writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.md'), notice);
  fs.copyFileSync(path.join(root, 'licensing/third-party.json'), path.join(outDir, 'licenses/components.json'));
  fs.copyFileSync(path.join(root, 'licensing/development-dependencies.json'), path.join(outDir, 'licenses/development-dependencies.json'));
  fs.writeFileSync(path.join(outDir, 'licenses/bundled-packages.json'), JSON.stringify([...bundledPackages.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
  const rows = data.components.map(component => `<tr><td>${escapeHtml(component.name)}</td><td>${escapeHtml(component.version)}</td><td>${escapeHtml(component.license)}</td><td>${component.licenseFiles.map(file => `<a href="${escapeHtml(packaged(file))}">${escapeHtml(path.basename(file))}</a>`).join(' · ')}</td></tr>`).join('\n');
  const texts = Object.keys(data.licenseFiles).map(file => `<details><summary>${escapeHtml(packaged(file))}</summary><pre>${escapeHtml(fs.readFileSync(fromRoot(file), 'utf8'))}</pre></details>`).join('\n');
  fs.writeFileSync(path.join(outDir, 'licenses.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TWICE · Open-source licenses</title><style>
:root{color-scheme:dark}body{font:14px/1.65 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;background:#0f1115;color:#e8eaed}a{color:#3dd6c4}table{border-collapse:collapse;width:100%;font-size:12px}td,th{text-align:left;padding:9px;border-bottom:1px solid #363b45;overflow-wrap:anywhere}details{margin:14px 0;border:1px solid #363b45;border-radius:8px;padding:12px}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace}.table{overflow-x:auto}
</style></head><body><h1>TWICE · Open-source licenses</h1><p>오픈소스 라이선스 · Reviewed ${escapeHtml(data.reviewed)}</p><p>TWICE's own code is MIT licensed. Third-party components retain their original licenses.</p><p>This software is based in part on the work of the Independent JPEG Group.</p><p><a href="THIRD_PARTY_NOTICES.md">Third-party notices and scope</a> · <a href="licenses/components.json">Provenance and hashes</a></p><h2>TWICE — MIT</h2><pre>${escapeHtml(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))}</pre><h2>Bundled components</h2><div class="table"><table><thead><tr><th>Component</th><th>Version / revision</th><th>License</th><th>Original texts</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Original license texts</h2>${texts}</body></html>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'inventory') {
    const file = path.join(root, 'licensing/development-dependencies.json');
    const inventory = { scope: `Installed development/build/test packages on ${process.platform}/${process.arch}; optional packages for other platforms are not installed here. This is not the shipped-component list.`, packages: installedInventory() };
    fs.writeFileSync(file, JSON.stringify(inventory, null, 2) + '\n');
    console.log(`Recorded ${inventory.packages.length} installed packages. Review changes before committing.`);
  } else {
    const data = checkLicenses(); console.log(`Licenses checked: ${data.components.length} components, ${data.assets.length} vendor assets, ${Object.keys(data.licenseFiles).length} original texts.`);
  }
}
