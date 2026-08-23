const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const packageRoot = path.join(__dirname, 'node_modules/compress-pdf');
const installScript = path.join(packageRoot, 'scripts/install.js');
const installResult = spawnSync(process.execPath, [installScript], { stdio: 'inherit' });

if (installResult.status !== 0) {
  process.exit(installResult.status || 1);
}

const ghostscriptRoot = path.join(packageRoot, 'bin/gs/ghostscript_linux');

function materializeLibraryLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      materializeLibraryLinks(entryPath);
      continue;
    }

    if (!entry.name.includes('.so') || fs.statSync(entryPath).size >= 1000) continue;
    const targetName = fs.readFileSync(entryPath, 'utf8').trim();
    const targetPath = path.join(directory, targetName);
    if (targetName && fs.existsSync(targetPath) && fs.statSync(targetPath).size >= 1000) {
      fs.copyFileSync(targetPath, entryPath);
    }
  }
}

materializeLibraryLinks(ghostscriptRoot);