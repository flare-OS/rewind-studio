const fs=require('fs');
const p='main.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace("  await windowRef.loadURL('rewind://app/index.html');\n  windowRef.once('ready-to-show', () => windowRef.show());\n  windowRef.on('closed', () => { windowRef = undefined; });", "  windowRef.once('ready-to-show', () => {\n    if (windowRef && !windowRef.isDestroyed()) windowRef.show();\n  });\n  await windowRef.loadURL('rewind://app/index.html');\n  if (!windowRef.isVisible()) windowRef.show();\n  windowRef.on('closed', () => { windowRef = undefined; });");
fs.writeFileSync(p,s);
