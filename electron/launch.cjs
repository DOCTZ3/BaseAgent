// ============================================
// 启动器 —— 保证 electron 以「桌面应用」而不是「普通 Node」启动
// ============================================
//
// 为什么需要这一层:环境里若存在 ELECTRON_RUN_AS_NODE,electron 会退化成
// 一个普通的 Node 运行时 —— app / ipcMain / BrowserWindow 全部是 undefined。
// 实测报错是 `Cannot read properties of undefined (reading 'handle')`,
// 指向 ipcMain.handle 那一行,而真正的原因(一个环境变量)完全看不出来。
//
// 这个变量常被 IDE、编辑器插件、以及各种把 electron 当 node 用的工具设上,
// 而且是**继承**下来的:用户自己没设过也可能有。所以不能靠文档提醒,
// 得在启动路径上摘掉它。
//
// 顺带做跨平台:npm 脚本在 Windows 上走 cmd.exe,`VAR= cmd` 那种前缀
// 语法不生效,所以用 Node 起子进程、显式给一份删掉该键的 env。
// ============================================

const { spawn } = require('child_process');
const path = require('path');

// electron 包导出的是二进制的绝对路径
const electronBin = require('electron');

const env = { ...process.env };
// 就是这一句:摘掉它,electron 才会以桌面模式启动
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [path.join(__dirname, 'main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

// 透传退出码:CI 或脚本里判断成败要靠它
child.on('close', code => process.exit(code ?? 0));
