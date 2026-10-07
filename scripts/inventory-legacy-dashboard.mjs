import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const legacy = path.resolve(workspace, '../infinid-dashboard');
const output = path.join(workspace, 'docs/dashboard-source-inventory.md');
function files(directory, extension) {
  return fs.readdirSync(path.join(legacy, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return files(relative, extension);
    return relative.endsWith(extension) ? [relative] : [];
  }).sort();
}
const controllers = files('controllers', '.js');
const models = files('models', '.js');
const routes = files('routes', '.js');
const pages = files('views/pages', '.ejs');
const lines = [
  '# Legacy dashboard source inventory',
  '',
  'Generated from `infinid-dashboard` by `node scripts/inventory-legacy-dashboard.mjs`. The code is not copied or modified. See `dashboard-inventory.md` for status, permissions, and data ownership.',
  '',
  `## Controllers (${controllers.length})`, '',
  '| File | Exported actions |', '| --- | --- |',
  ...controllers.map(file => {
    const source = fs.readFileSync(path.join(legacy, file), 'utf8');
    const actions = [...source.matchAll(/exports\.(\w+)\s*=/g)].map(match => match[1]);
    return `| \`${file}\` | ${[...new Set(actions)].join(', ') || 'none'} |`;
  }),
  '', `## Models (${models.length})`, '',
  models.map(file => `\`${file}\``).join(', '),
  '', `## Route declarations (${routes.length} files)`, '',
  '| File | Local declarations (mount paths compose in parent routers) |', '| --- | --- |',
  ...routes.map(file => {
    const source = fs.readFileSync(path.join(legacy, file), 'utf8');
    const declarations = [...source.matchAll(/\.(get|post|put|patch|delete|use)\(\s*['"]([^'"]+)['"]/g)].map(match => `${match[1].toUpperCase()} ${match[2]}`);
    return `| \`${file}\` | ${declarations.map(value => `\`${value}\``).join(', ') || 'no literal path'} |`;
  }),
  '', `## EJS pages (${pages.length})`, '',
  ...pages.map(file => `- \`${file}\``),
  '',
  'Route extraction lists literal declarations only. Middleware chains and dynamic route composition remain in the source and are summarized in `dashboard-inventory.md`.',
];
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(output);
