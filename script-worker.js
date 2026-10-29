import { Indexable, LuauState, Mutable } from './node_modules/luau-web/src/index.js';

/* REWIND Studio's Luau runner.
 *
 * The real Luau VM runs inside this worker. The globals below are a small,
 * mutable Roblox-shaped surface so scripts can be authored and tested
 * without pretending that the desktop editor is an authoritative game
 * server. Instance writes stay inside the sandbox and are not applied to
 * the editor scene.
 */

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'nil';
  if (value === undefined) return 'nil';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function serviceTable(name, extra = {}) {
  return Mutable({
    Name: name,
    ClassName: name,
    ...extra
  });
}

function makeWorkspace(context) {
  const children = Array.isArray(context?.objects) ? context.objects : [];
  const childTables = {};
  for (const child of children) {
    const name = String(child.name || 'Part');
    childTables[name] = Mutable({
      Name: name,
      ClassName: String(child.kind || 'Part'),
      Position: {
        X: Number(child.position?.[0] || 0),
        Y: Number(child.position?.[1] || 0),
        Z: Number(child.position?.[2] || 0)
      },
      Size: {
        X: Number(child.size?.[0] || 1),
        Y: Number(child.size?.[1] || 1),
        Z: Number(child.size?.[2] || 1)
      },
      Anchored: child.anchored !== false,
      Destroy: Indexable(() => {})
    });
  }
  const workspace = serviceTable('Workspace', {
    Gravity: 18,
    GetChildren: Indexable(() => Object.values(childTables)),
    FindFirstChild: Indexable(name => childTables[String(name)] || null),
    WaitForChild: Indexable(name => childTables[String(name)] || null),
    ...childTables
  });
  return workspace;
}

function makeRuntime(context, write) {
  const workspace = makeWorkspace(context);
  const localPlayer = Mutable({
    Name: 'Player',
    DisplayName: 'Player',
    UserId: 0,
    Character: null,
    GetAttribute: Indexable(() => null),
    SetAttribute: Indexable(() => {}),
    FindFirstChild: Indexable(() => null),
    WaitForChild: Indexable(() => null)
  });

  const dataStore = {
    GetAsync: Indexable(() => null),
    SetAsync: Indexable(() => {}),
    UpdateAsync: Indexable((...args) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') { try { return callback(null); } catch { return null; } }
      return null;
    }),
    RemoveAsync: Indexable(() => {}),
    IncrementAsync: Indexable(() => 0)
  };

  const dataStoreService = serviceTable('DataStoreService', {
    GetDataStore: Indexable(() => dataStore)
  });

  const players = serviceTable('Players', {
    LocalPlayer: localPlayer,
    GetPlayers: Indexable(() => [localPlayer]),
    GetPlayerByUserId: Indexable(() => null),
    GetUserIdFromNameAsync: Indexable(() => 0),
    GetNameFromUserIdAsync: Indexable(() => 'Player'),
    PlayerAdded: { Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) })), Once: Indexable(() => {}) },
    PlayerRemoving: { Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) })), Once: Indexable(() => {}) }
  });

  const runService = serviceTable('RunService', {
    Heartbeat: { Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) })) },
    RenderStepped: { Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) })) },
    IsClient: () => String(context?.scriptType || 'LocalScript') !== 'ServerScript',
    IsServer: () => String(context?.scriptType || 'LocalScript') === 'ServerScript'
  });

  const services = {
    Workspace: workspace,
    Players: players,
    Lighting: serviceTable('Lighting', { Brightness: 2, ClockTime: 14, Ambient: { R: 0.5, G: 0.5, B: 0.6 } }),
    ReplicatedStorage: serviceTable('ReplicatedStorage'),
    ServerScriptService: serviceTable('ServerScriptService'),
    StarterGui: serviceTable('StarterGui'),
    RunService: runService,
    DataStoreService: dataStoreService,
    MarketplaceService: serviceTable('MarketplaceService', {
      PromptGamePassPurchase: Indexable((...args) => write('log', [`Marketplace prompt requested for gamepass ${stringify(args.at(-1))} (local preview).`]))
    }),
    HttpService: serviceTable('HttpService', {
      GenerateGUID: Indexable(() => crypto.randomUUID()),
      JSONEncode: Indexable(value => JSON.stringify(value)),
      JSONDecode: Indexable(value => { try { return JSON.parse(value); } catch { return null; } })
    }),
    TweenService: serviceTable('TweenService', {
      Create: Indexable(() => ({ Play: Indexable(() => {}), Cancel: Indexable(() => {}) }))
    }),
    BadgeService: serviceTable('BadgeService', {
      AwardBadge: Indexable(() => false),
      UserHasBadgeAsync: Indexable(() => false)
    })
  };

  const game = serviceTable('DataModel', {
    GetService: Indexable(name => services[String(name)] || serviceTable(String(name))),
    FindService: Indexable(name => services[String(name)] || null),
    ...services
  });

  let virtualTime = 0;
  const start = Date.now();
  const task = {
    wait: Indexable((...args) => {
      const seconds = Math.max(0, Math.min(10, Number(args.at(-1)) || 0));
      return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }),
    spawn: Indexable((...args) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch (error) { write('error', [String(error?.message || error)]); } }, 0);
    }),
    delay: Indexable((...args) => {
      const seconds = Math.max(0, Math.min(10, Number(args[0]) || 0));
      const callback = args.at(-1);
      if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch (error) { write('error', [String(error?.message || error)]); } }, seconds * 1000);
    }),
    defer: Indexable((...args) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch (error) { write('error', [String(error?.message || error)]); } }, 0);
    })
  };

  const scriptContext = Mutable({
    Name: String(context?.scriptName || 'Script'),
    ClassName: String(context?.scriptType || 'LocalScript'),
    Parent: workspace,
    Enabled: true,
    Disabled: false,
    Destroy: Indexable(() => {})
  });

  const instanceNew = Indexable(className => {
    const name = String(className || 'Instance');
    const object = Mutable({
      Name: name,
      ClassName: name,
      Parent: null,
      Position: { X: 0, Y: 0, Z: 0 },
      Size: { X: 1, Y: 1, Z: 1 },
      Color: { R: 0.5, G: 0.4, B: 0.9 },
      Anchored: true,
      Transparency: 0,
      Destroy: Indexable(() => {}),
      FindFirstChild: Indexable(() => null),
      WaitForChild: Indexable(() => null),
      GetChildren: Indexable(() => []),
      SetAttribute: Indexable(() => {}),
      GetAttribute: Indexable(() => null),
      Connect: Indexable(() => ({ Disconnect: Indexable(() => {}) }))
    });
    if (name === 'Part') { object.Name = 'Part'; object.Size = Mutable({ X: 4, Y: 1, Z: 2 }); }
    if (name === 'Script' || name === 'LocalScript' || name === 'ModuleScript') { object.Source = ''; }
    return object;
  });

  const vector = (x = 0, y = 0, z = 0) => Mutable({ X: Number(x) || 0, Y: Number(y) || 0, Z: Number(z) || 0 });
  const vector3 = {
    new: Indexable((x, y, z) => vector(x, y, z)),
    zero: vector(0, 0, 0),
    one: vector(1, 1, 1)
  };

  const cframe = {
    new: Indexable((x, y, z) => ({
      X: Number(x) || 0,
      Y: Number(y) || 0,
      Z: Number(z) || 0,
      Position: vector(x, y, z),
      __type: 'CFrame'
    })),
    identity: { Position: vector(0, 0, 0), __type: 'CFrame' }
  };

  const color3 = {
    new: Indexable((r = 0, g = 0, b = 0) => ({ R: Number(r) || 0, G: Number(g) || 0, B: Number(b) || 0 })),
    fromRGB: Indexable((r = 0, g = 0, b = 0) => ({ R: (Number(r) || 0) / 255, G: (Number(g) || 0) / 255, B: (Number(b) || 0) / 255 }))
  };

  return {
    game,
    workspace,
    script: scriptContext,
    task,
    wait: task.wait,
    tick: Indexable(() => (Date.now() - start) / 1000),
    time: Indexable(() => (Date.now() - start) / 1000),
    elapsedTime: Indexable(() => (Date.now() - start) / 1000),
    Vector3: vector3,
    CFrame: cframe,
    Color3: color3,
    Instance: { new: instanceNew },
    Enum: new Proxy({}, { get: () => new Proxy({}, { get: (_t, key) => ({ Name: String(key), Value: 0 }) }) }),
    warn: Indexable((...values) => write('warn', values)),
    print: Indexable((...values) => write('log', values)),
    error: Indexable((...values) => write('error', values))
  };
}

const readyPromise = (async () => {
  self.postMessage({ type: 'status', text: 'Compiling the Luau virtual machine…' });
  const warmup = await LuauState.createAsync({});
  try { warmup.destroy(); } catch { /* Warmup only. */ }
  self.postMessage({ type: 'ready' });
  return true;
})().catch(error => {
  self.postMessage({ type: 'init-error', message: String(error?.message || error) });
  return false;
});

self.onmessage = async event => {
  const { id = 'run', source, name = 'Script', type = 'LocalScript', context = {} } = event.data || {};
  const ready = await readyPromise.catch(() => false);
  if (!ready) {
    self.postMessage({ type: 'error', id, text: 'The Luau runtime could not start.' });
    self.postMessage({ type: 'done', id });
    return;
  }

  const write = (level, values) => self.postMessage({
    type: 'output',
    id,
    level,
    text: (Array.isArray(values) ? values : [values]).map(stringify).join('\t')
  });

  let state;
  try {
    state = await LuauState.createAsync(makeRuntime({ ...context, scriptName: name, scriptType: type }, write));
    const result = state.loadstring(String(source || ''), String(name), true)();
    if (result && typeof result.then === 'function') await result;
    self.postMessage({ type: 'done', id });
  } catch (error) {
    write('error', [String(error?.message || error)]);
    self.postMessage({ type: 'done', id });
  } finally {
    try { state?.destroy(); } catch { /* State is discarded after this run. */ }
  }
};
