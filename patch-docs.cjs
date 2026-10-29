const fs=require('fs');
let r=fs.readFileSync('README.md','utf8');
r=r.replace('%APPDATA%\\REWIND Studio\\RewindProjects','%APPDATA%\\rewind-studio\\RewindProjects');
fs.writeFileSync('README.md',r);
let w=fs.readFileSync('script-worker.js','utf8');
w=w.replace(' * The real Luau VM runs inside this worker. The globals below are a small,\n * read-only Roblox-shaped surface so scripts can be authored and tested\n * without pretending that the desktop editor is an authoritative game\n * server. Scene writes are intentionally not simulated.', ' * The real Luau VM runs inside this worker. The globals below are a small,\n * mutable Roblox-shaped surface so scripts can be authored and tested\n * without pretending that the desktop editor is an authoritative game\n * server. Instance writes stay inside the sandbox and are not applied to\n * the editor scene.');
fs.writeFileSync('script-worker.js',w);
