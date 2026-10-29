# REWIND Studio for Windows

REWIND Studio is the desktop editor for REWIND. It is a local-first 3D place builder: projects are stored on this computer, and the REWIND API is only used for accounts, cloud places, approval-gated assets, publishing, and playtest session registration.

## Run from source

Install Node.js 22 or newer, then run from this folder:

```powershell
npm install
npm start
```

The Studio loads a short splash screen and then opens the home hub. If you are not signed in, a separate sign-in window opens automatically; you can continue as a guest and build locally.

The API defaults to `https://api.rwd.2bd.net`. Point the desktop app at another deployment with:

```powershell
$env:REWIND_API_BASE = 'http://localhost:3000'
npm start
```

## What is included

- **Home hub** — recent cloud experiences, a five-template starter strip, local project shortcuts, account summary, and one-click creation.
- **Local Projects** — the **Local** tab in the editor dock and the **Local Projects** page in the home sidebar. Projects are `.rwdproj` JSON files stored in `%APPDATA%\rewind-studio\RewindProjects`.
- **Cloud experiences** — sign in to list, open, create, and publish places. Place icons and thumbnails load from the account's approved assets.
- **Editor** — viewport selection, move/rotate/scale gizmos, parts (block, sphere, cylinder, wedge, torus, plane, spawn, point light, bean rig), Explorer, Properties, undo/redo, snapping, and a starter GUI editor.
- **Environment** — six sky presets, a six-image custom cube skybox, sun elevation/azimuth, turbidity, Rayleigh scattering, ambient and sun intensity, star field, fog, exposure, and bloom. Sky settings in Studio Settings are the defaults for new places; the Environment dock edits the open place.
- **Graphics** — quality presets, shadows and shadow resolution, anti-aliasing (restart), ACES/Reinhard/Cineon/Linear tone mapping, exposure, field of view, render scale, bloom strength, grid, and axes.
- **Luau** — a real Luau VM (`luau-web`) runs in an isolated worker with a Roblox-shaped global surface (`game`, `workspace`, `script`, `task`, `Vector3`, `CFrame`, `Color3`, `Instance`, services, DataStore stubs). Client scripts preview locally; server scripts can also sync to a published place through `/api/multiplayer`.
- **Export** — export the open place as a single `.rwdplace` JSON file, or open an exported place back into the editor.

## Controls

- **Q / W / E / R** — select / move / rotate / scale.
- **Right-drag** orbit, **scroll** zoom, **click** select.
- **F5** playtest, **F8** run server scripts, **Shift+F5** or **Esc** stop.
- **WASD** move, **Space** jump, **Shift** run during a playtest.
- **Ctrl+S** save, **Ctrl+Shift+S** save as, **Ctrl+E** export, **Ctrl+Z / Ctrl+Y** undo/redo.

## Files and limits

Projects use `format: "rewind-project"` version 2 and contain `place.objects`, `place.ui`, `place.scripts`, `environment`, and `settings`. Exported places use the same document with the `.rwdplace` extension.

This build does not provide an authoritative game server or synchronized multiplayer simulation; `/api/multiplayer` registers playtest sessions and stores server scripts, but the VM is a preview sandbox. Luau runs have a 5 second execution limit after the VM starts. Asset uploads require the Neptune plan or above, and the API blocks place creation for one day after a free account signs up.

## Installer placement

When the installer is ready, place the built file at `Website/app/studio.exe`; the website download button links to that path. `Website/` is a separate Git repository, so this desktop source folder is not included when committing the site.

All text files in this folder are UTF-8 without a byte-order mark, and project files are written as UTF-8.
