const { copyFile } = require('node:fs/promises');
const path = require('node:path');

module.exports = {
  appId: 'app.texel.editor',
  productName: 'Texel',
  executableName: 'Texel',
  directories: { output: 'release' },
  asar: true,
  npmRebuild: false,
  files: ['dist/**/*', 'electron/**/*.cjs', 'package.json'],
  extraResources: [{ from: '.packaging/native', to: 'native', filter: ['**/*'] }],
  // Use the loader distributed with this exact Electron release; its notices ship with Electron.
  async afterPack({ appOutDir }) {
    await copyFile(path.join(appOutDir, 'vulkan-1.dll'), path.join(appOutDir, 'resources', 'native', 'vulkan-1.dll'));
  },
  fileAssociations: [{ ext: 'txl', name: 'Texel.Document', description: 'Texel image document', icon: 'txl.ico', role: 'Editor' }],
  win: { icon: 'icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    artifactName: 'Texel-${version}-Setup.${ext}',
    oneClick: false,
    include: 'build/installer.nsh',
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Texel',
    deleteAppDataOnUninstall: false,
  },
};
