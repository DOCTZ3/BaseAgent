// Electron packaged entry.
//
// Some IDEs and Electron-based tools leave ELECTRON_RUN_AS_NODE in the
// environment. If a packaged app inherits it, Electron starts as plain Node and
// `require('electron').app` is undefined before main.cjs can do anything.
//
// In that case, relaunch the same executable with the variable removed. In the
// normal desktop runtime this file simply enters the real main process.

const electron = require('electron');

if (!electron.app) {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env,
    windowsHide: false,
  });

  child.on('close', code => process.exit(code ?? 0));
} else {
  require('./main.cjs');
}
