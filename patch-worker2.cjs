const fs=require('fs');
const p='script-worker.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace("})().catch(error => {\n  self.postMessage({ type: 'init-error', message: String(error?.message || error) });\n  throw error;\n});", "})().catch(error => {\n  self.postMessage({ type: 'init-error', message: String(error?.message || error) });\n  return false;\n});");
s=s.replace("  try {\n    await readyPromise;\n  } catch {\n    self.postMessage({ type: 'error', id, text: 'The Luau runtime could not start.' });\n    self.postMessage({ type: 'done', id });\n    return;\n  }", "  const ready = await readyPromise.catch(() => false);\n  if (!ready) {\n    self.postMessage({ type: 'error', id, text: 'The Luau runtime could not start.' });\n    self.postMessage({ type: 'done', id });\n    return;\n  }");
fs.writeFileSync(p,s);
