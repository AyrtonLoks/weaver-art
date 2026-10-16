import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const webDist = path.join(root, 'apps', 'web', 'dist');
const rootDist = path.join(root, 'dist');

if (fs.existsSync(webDist)) {
  fs.mkdirSync(rootDist, { recursive: true });
  fs.cpSync(webDist, rootDist, { recursive: true });
  const count = fs.readdirSync(rootDist).length;
  console.log(`[sync-dist] Sincronizado apps/web/dist -> dist/ (${count} itens estáticos prontos para deploy online)`);
} else {
  console.warn('[sync-dist] apps/web/dist não encontrado para sincronização.');
}
