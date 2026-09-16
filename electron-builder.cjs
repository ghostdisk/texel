const { rm } = require('node:fs/promises');
const path = require('node:path');

module.exports = {
  appId: 'app.texel.editor',
  productName: 'Texel',
  executableName: 'Texel',
  compression: 'maximum',
  directories: { output: 'release', buildResources: 'assets/branding' },
  asar: true,
  npmRebuild: false,
  electronLanguages: ['en-US'],
  files: ['dist/**/*', 'electron/**/*.cjs', 'assets/branding/*.png', 'package.json'],
  extraResources: [
    {
      from: 'packages',
      to: 'packages',
      filter: ['**/*', '!**/native{,/**/*}', '!**/third_party{,/**/*}', '!**/build{,/**/*}', '!**/setup.mjs', '!**/build.mjs'],
    },
    {
      from: 'packages/texel-editor/local-ai-base/build/install',
      to: 'packages/texel-editor/local-ai-base/runtime',
      filter: ['**/*'],
    },
    {
      from: 'packages/texel-editor/local-ai-vulkan/build/install',
      to: 'packages/texel-editor/local-ai-vulkan/runtime',
      filter: ['**/*'],
    },
  ],
  async afterPack({ appOutDir }) {
    await Promise.all([
      rm(path.join(appOutDir, 'vk_swiftshader.dll'), { force: true }),
      rm(path.join(appOutDir, 'vk_swiftshader_icd.json'), { force: true }),
    ]);
  },
  fileAssociations: [{ ext: 'txl', name: 'Texel.Document', description: 'Texel image document', icon: 'txl.ico', role: 'Editor' }],
  win: { icon: 'icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    artifactName: 'Texel-${version}-Setup.${ext}',
    uninstallDisplayName: 'Texel',
    differentialPackage: false,
    oneClick: false,
    include: 'build/installer.nsh',
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Texel',
    deleteAppDataOnUninstall: false,
  },
};
