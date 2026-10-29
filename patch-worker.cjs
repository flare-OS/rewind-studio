const fs=require('fs');
const p='script-worker.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace("import { Indexable, LuauState } from './node_modules/luau-web/src/index.js';", "import { Indexable, LuauState, Mutable } from './node_modules/luau-web/src/index.js';");
s=s.replace(/function serviceTable\(name, extra = \{\}\) \{\n  return \{\n    Name: name,\n    ClassName: name,\n    \.\.\.extra\n  \};\n\}/, "function serviceTable(name, extra = {}) {\n  return Mutable({\n    Name: name,\n    ClassName: name,\n    ...extra\n  });\n}");
// Wrap workspace child entries
s=s.replace(/    childTables\[name\] = \{\n/, '    childTables[name] = Mutable({\n');
s=s.replace(/      Anchored: child\.anchored !== false,\n      Destroy: Indexable\(\(\) => \{\}\)\n    \};\n/, '      Anchored: child.anchored !== false,\n      Destroy: Indexable(() => {})\n    });\n');
// Wrap localPlayer
s=s.replace(/  const localPlayer = \{\n/, '  const localPlayer = Mutable({\n');
s=s.replace(/    WaitForChild: Indexable\(\(\) => null\)\n  \};\n\n  const dataStore/, '    WaitForChild: Indexable(() => null)\n  });\n\n  const dataStore');
// Wrap instance objects and nested vectors
s=s.replace(/    const object = \{\n/, '    const object = Mutable({\n');
s=s.replace(/      Connect: Indexable\(\(\) => \(\{ Disconnect: Indexable\(\(\) => \{\}\) \}\)\)\n    \};\n    if \(name === 'Part'\) \{ object\.Name = 'Part'; object\.Size = \{ X: 4, Y: 1, Z: 2 \}; \}\n    if \(name === 'Script' \|\| name === 'LocalScript' \|\| name === 'ModuleScript'\) \{ object\.Source = ''; \}\n    return object;/, "      Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) }))\n    });\n    if (name === 'Part') { object.Name = 'Part'; object.Size = Mutable({ X: 4, Y: 1, Z: 2 }); }\n    if (name === 'Script' || name === 'LocalScript' || name === 'ModuleScript') { object.Source = ''; }\n    return object;");
// Wrap scriptContext
s=s.replace(/  const scriptContext = \{\n/, '  const scriptContext = Mutable({\n');
s=s.replace(/    Disabled: false,\n    Destroy: Indexable\(\(\) => \{\}\)\n  \};\n\n  const instanceNew/, '    Disabled: false,\n    Destroy: Indexable(() => {})\n  });\n\n  const instanceNew');
// Vector/cframe/color
s=s.replace(/  const vector = \(x = 0, y = 0, z = 0\) => \(\{ X: Number\(x\) \|\| 0, Y: Number\(y\) \|\| 0, Z: Number\(z\) \|\| 0 \}\);/, "  const vector = (x = 0, y = 0, z = 0) => Mutable({ X: Number(x) || 0, Y: Number(y) || 0, Z: Number(z) || 0 });");
s=s.replace(/    new: Indexable\(\(x, y, z\) => \(\{\n      X: Number\(x\) \|\| 0,\n      Y: Number\(y\) \|\| 0,\n      Z: Number\(z\) \|\| 0,\n      Position: vector\(x, y, z\),\n      __type: 'CFrame'\n    \}\),\n    identity: \{ Position: vector\(0, 0, 0\), __type: 'CFrame' \}/, "    new: Indexable((x, y, z) => Mutable({\n      X: Number(x) || 0,\n      Y: Number(y) || 0,\n      Z: Number(z) || 0,\n      Position: vector(x, y, z),\n      __type: 'CFrame'\n    })),\n    identity: Mutable({ Position: vector(0, 0, 0), __type: 'CFrame' })");
s=s.replace(/    new: Indexable\(\(r = 0, g = 0, b = 0\) => \(\{ R: Number\(r\) \|\| 0, G: Number\(g\) \|\| 0, B: Number\(b\) \|\| 0 \}\),\n    fromRGB: Indexable\(\(r = 0, g = 0, b = 0\) => \(\{ R: \(Number\(r\) \|\| 0\) \/ 255, G: \(Number\(g\) \|\| 0\) \/ 255, B: \(Number\(b\) \|\| 0\) \/ 255 \}\)\)/, "    new: Indexable((r = 0, g = 0, b = 0) => Mutable({ R: Number(r) || 0, G: Number(g) || 0, B: Number(b) || 0 })),\n    fromRGB: Indexable((r = 0, g = 0, b = 0) => Mutable({ R: (Number(r) || 0) / 255, G: (Number(g) || 0) / 255, B: (Number(b) || 0) / 255 }))");
fs.writeFileSync(p,s);
