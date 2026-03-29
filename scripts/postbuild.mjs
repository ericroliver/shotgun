/**
 * scripts/postbuild.mjs
 * Post-build script: prepends #!/usr/bin/env node shebang to dist/index.js
 * and marks it executable. Runs automatically after `npm run build`.
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distIndex = join(__dirname, '..', 'dist', 'index.js');

const original = readFileSync(distIndex, 'utf8');

if (!original.startsWith('#!/usr/bin/env node')) {
  writeFileSync(distIndex, '#!/usr/bin/env node\n' + original, 'utf8');
  console.log('✓ Added shebang to dist/index.js');
}

chmodSync(distIndex, 0o755);
console.log('✓ dist/index.js is now executable');
