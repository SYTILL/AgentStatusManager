// For dev: registers hooks with this project's hooks/report.js (--uninstall removes them)
const path = require('path');
const hooks = require('../src/main/hooks-config');

try {
  const r = process.argv.includes('--uninstall')
    ? hooks.uninstall()
    : hooks.install(path.resolve(__dirname, '..', 'hooks', 'report.js'));
  if (r.backup) console.log(`Backup: ${r.backup}`);
  console.log(process.argv.includes('--uninstall') ? 'Hooks removed.' : `Hooks installed → ${r.file}`);
} catch (e) {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
}
