---
name: helm-assets
description: 3D, 2D and audio asset craft (budgets, naming, Blender scripting, LODs, textures, export, licensing, Git LFS). Use when you are a Helm Asset builder.
---

# Helm Assets Craft

This skill covers what excellent asset work looks like. `helm-specialist` covers how you work inside Helm. Excellent asset work means every asset in the game traces back to a listed need, a source file, a license and a budget; it imports into the engine at the right scale, orientation and pivot with no manual fixing; it fits its polygon, texture and file-size budget on every target platform; and the proof is renders, import logs and a budget table a gate can check without opening Blender.

Your role is `assets`. Default scope: `assets/**`, `art/**`, `game/Content/**`, `game/assets/**`, `reports/assets/**` (the lead sets the exact layout in ARCHITECTURE.md). The Core builder owns gameplay code and how assets are referenced from data; the UI builder owns menus, HUD and UI art direction; platform builders own store submission. Follow `helm-game` for game context and `helm-unreal` when the project tools include `unreal`.

---

## 1. The asset list and budgets come first

**Nothing gets made that is not on the list.** Before producing assets, write or update an asset list in SPEC (via the lead, or in a file the SPEC links such as `assets/ASSET_LIST.md` if that is in your scope). One row per asset:

| Column | Example |
|---|---|
| ID | `prop_crate_wood_01` |
| Type | static mesh, skeletal mesh, sprite sheet, texture set, UI icon, music, SFX, voice |
| Used by | level 1, enemy spawner, shop UI |
| Source | made procedurally, made in Blender, CC0 from a named site, provided by the human |
| Budget | triangles per LOD, texture size, file size, duration |
| Status | planned, greybox, final, verified in engine |

**Budgets per platform.** Agree them with the lead and record them in ACCEPTANCE so they can be checked. Starting points to adjust per project (state the ones you choose):

| Asset | Mobile | Desktop / console | Web |
|---|---|---|---|
| Hero character (LOD0) | 5k to 15k triangles | 30k to 100k+ triangles | 5k to 20k triangles |
| Prop (LOD0) | 100 to 2k triangles | 1k to 10k triangles | 100 to 3k triangles |
| Hero texture set | 1024 px | 2048 to 4096 px | 1024 px |
| Prop texture set | 256 to 512 px | 1024 to 2048 px | 512 px |
| Total texture memory | set per device tier | set per tier | keep download small |

For Unreal Nanite meshes on desktop, triangle counts matter less than disk size and material count; record the budget the lead chooses. Web games also need a total download budget (for example a first-load size in MB) because players wait for every byte.

---

## 2. Naming and folder layout

- **Lowercase, ASCII, no spaces,** words joined by underscores, with a type prefix and a zero-padded variant: `sm_crate_wood_01`, `sk_hero`, `t_crate_wood_01_basecolor`, `m_crate_wood`, `anim_hero_run`, `sfx_door_open_01`, `mus_level1_loop`. Unreal projects commonly use prefixes such as `SM_`, `SK_`, `T_`, `M_`, `MI_`, `A_`; follow whichever convention ARCHITECTURE.md records and apply it consistently.
- **Texture suffixes say what the map is:** `_basecolor`, `_normal`, `_orm` (or `_roughness`, `_metallic`, `_ao`), `_emissive`, `_opacity`.
- **Layout that separates sources from exports:**

```
assets/
  source/<category>/<asset_id>/   # .blend, .psd/.kra/.aseprite, layered audio projects (Git LFS)
  export/<category>/<asset_id>/   # .glb/.fbx, .png/.ktx2, .wav/.ogg ready for the engine
  scripts/                        # bpy and conversion scripts (plain text, reviewed)
  LICENSES.md                     # provenance and license for every third-party file
game/Content/... or game/assets/...  # engine-side copies or imports, per ARCHITECTURE.md
```

- **IDs are stable.** Once the Core builder references an asset ID from data, never rename it silently; message them first, and in Unreal fix redirectors (see `helm-unreal`).

---

## 3. Sources versus exports

- **Keep the editable source.** Commit `.blend` files (and layered image or audio sources) in `assets/source/`. An exported mesh alone cannot be fixed later without rework.
- **Export format by engine:**
  - **glTF 2.0** (`.glb` binary, or `.gltf` plus files) for web engines (three.js, Babylon.js, PixiJS for textures) and Godot. It is an open Khronos standard with PBR metallic-roughness materials built in.
  - **FBX** for Unreal and Unity, which have the most mature FBX import paths. Both engines also import glTF in current versions; use it if ARCHITECTURE.md says so.
  - **USDZ / Reality files** for RealityKit and Apple AR when the project targets those.
  - **OBJ** only for simple static meshes where nothing else is supported.
- **Exports are reproducible.** Generate them with a committed script (section 10), not by hand, so anyone can rebuild every export from sources with one command. Record the exporter settings in the script.
- **One asset per export file** unless the engine workflow needs a combined scene (for example a modular kit exported per piece).

---

## 4. Scale, units, axes and pivots

Wrong scale or rotation is the most common asset bug. Do not trust memory or forum advice; verify with a reference.

| Tool / engine | Up axis | Units | Handedness |
|---|---|---|---|
| Blender | Z up | 1 unit = 1 m by default | right-handed |
| glTF 2.0 | Y up (front faces +Z) | metres | right-handed |
| Godot | Y up (forward is -Z) | metres | right-handed |
| Unity | Y up (forward is +Z) | metres | left-handed |
| Unreal | Z up (forward is +X) | centimetres | left-handed |

Rules:
- **Model at real-world scale in metres** in Blender (a door about 2 m tall, a character about 1.8 m) unless the SPEC sets a stylized scale.
- **Let the exporter convert axes.** The Blender glTF exporter writes Y-up by default. For FBX, set the forward and up axes and the scale options the target engine expects, write them into the export script, and do not mix per-asset hacks.
- **Verify with a 1 m reference cube.** Export a 1 m cube with the same script, import it, and confirm it measures 1 m (100 units in Unreal) and faces the right way. Keep the result in the import log. Repeat when the export script changes.
- **Apply transforms before export.** Rotation and scale applied (`bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)`), so the object has scale 1 and rotation 0 in the export. Unapplied scale breaks physics, collisions and skinned meshes.
- **Pivots by usage:** characters and props that sit on the ground have the origin at the bottom centre; doors at the hinge; weapons at the grip; modular pieces at a grid corner, with dimensions on the agreed grid (for example 1 m or 2 m). Write the pivot rules into the asset list so the Core builder can place things in code.
- **Forward direction is consistent:** characters and vehicles face the engine's forward axis after import, so gameplay code does not need per-asset rotation offsets.

---

## 5. Meshes, UVs and LODs

- **Clean topology:** no non-manifold geometry, no zero-area faces, no duplicate vertices, consistent outward normals, no hidden interior faces. Quads for deforming areas, triangles are fine for static props (engines triangulate anyway).
- **Smoothing:** set sharp edges or auto smooth deliberately and export normals (and tangents where the engine wants them) so shading matches the preview.
- **Collision:** simple collision shapes (boxes, capsules, convex hulls) named by the engine's convention (Unreal: `UCX_<mesh>`, `UBX_<mesh>` prefixes) or built in the engine by the Core builder. Never use the render mesh as collision for moving objects.
- **UV unwrapping:** no overlaps on maps that bake unique detail (normal, AO, lightmaps); overlaps and mirrored islands are fine for tiled or shared textures. Leave padding between islands (for example 4 to 8 px at the target resolution) to avoid mip bleeding.
- **Texel density is consistent** within a scene: choose a value (for example 512 or 1024 px per metre for first-person desktop, lower for mobile or top-down cameras), record it, and keep assets close to it so nothing looks blurry next to something sharp.
- **Lightmap UVs** in a second UV channel when the engine bakes lighting (Unreal can generate them on import; Unity can too). Agree who generates them.
- **LODs** for anything seen at a distance: typically LOD1 at about 50% of the triangles, LOD2 at about 25%, LOD3 lower or an impostor, with screen-size or distance thresholds set in the engine. Generate them with the Decimate modifier in a script or with the engine's automatic LOD tools, then check silhouettes. Name exported LODs by the engine's convention (Unity: `_LOD0`, `_LOD1` suffixes on child meshes).
- **Materials per mesh are few.** Each material slot is usually a separate draw call. Combine where possible; use atlases for small props.

---

## 6. PBR textures and compression

**Metallic-roughness PBR** is the default for glTF, Unreal, Unity URP/HDRP and Godot:
- **Base color** in sRGB, no baked lighting or shadows, physically plausible values (avoid pure black and pure white albedo).
- **Normal** maps in linear (non-color) space. Blender, glTF, Unity and Godot use the OpenGL convention (green up); Unreal uses the DirectX convention (green down). Flip the green channel for Unreal or set the import option, and check a bevelled test surface.
- **Roughness, metallic, ambient occlusion** in linear space. Pack them into one **ORM** texture (R = occlusion, G = roughness, B = metallic), which matches glTF's metallic-roughness channels and Unreal's common convention and saves memory. Unity URP and HDRP use different packings (for example HDRP's mask map); pack to what the engine's shader reads.
- **Power-of-two sizes** (256, 512, 1024, 2048, 4096) for mipmaps and block compression. Square unless there is a reason.
- **Source textures** stay lossless (PNG, TGA, EXR for HDR) in `assets/source/`; compression happens at export or in the engine.

**GPU compression per platform** (the engine usually converts on import or cook; set the per-texture type correctly so it chooses the right format):

| Platform | Formats |
|---|---|
| Desktop and console | BC1 (opaque), BC3 (alpha), BC4 (single channel), BC5 (normal maps), BC7 (high-quality color) |
| iOS and modern Android | ASTC (block size chosen per texture type, for example 4x4 for normals and 6x6 or 8x8 for color) |
| Older Android baseline | ETC2 |
| Web | KTX2 with Basis Universal (glTF extension `KHR_texture_basisu`), which transcodes to the GPU's format at load |

- **Mark texture types** in the engine (color, normal, mask, UI) so compression, sRGB and mipmaps are right. UI and pixel-art textures usually disable mipmaps and use nearest or no filtering as the art style requires.
- **Measure memory,** not file size on disk: a 2048 px RGBA texture uncompressed with mips is about 21 MB of GPU memory; compressed it is a fraction of that. Put the totals in the budget table.

---

## 7. Rigging and animation

- **One skeleton per character family** shared across animations. Bone names stable and consistent (`spine_01`, `hand_l`); agree names with the Core builder if code attaches items or reads sockets.
- **Rest pose** at the origin, facing the engine forward axis after conversion, scale applied. Deform bones only in the export (no control rig helpers), and no leaf bones unless the engine wants them.
- **Weights:** at most 4 influences per vertex for mobile and web, normalized weights, no unweighted vertices.
- **Animations** as separate actions or clips named `anim_<character>_<action>` (`anim_hero_run`), with loop flags and root motion decided per clip and recorded. Bake to keyframes on export. Add animation events or notifies (footsteps, hit frames) in the engine or as named markers agreed with the Core builder.
- **Frame rate** of authored animation recorded (for example 30 fps); the engine resamples.
- **Verify in the engine:** import, play each clip on the character in a test level or preview, and screenshot a few frames.

---

## 8. 2D sprites, atlases, icons and store art

- **Sprites** exported as PNG with transparent backgrounds, consistent pixels-per-unit across the game (record it), trimmed with a consistent pivot (bottom centre for characters).
- **Atlases** pack frames and small sprites to cut draw calls: Unity Sprite Atlas, Godot `AtlasTexture` or sprite sheets, Phaser and PixiJS texture atlas JSON. If Aseprite is installed, its CLI exports sheets and JSON data (`aseprite -b input.aseprite --sheet out.png --data out.json`); TexturePacker is a paid tool and needs `helm_need` (about: `spending`) unless already licensed.
- **Pixel art:** integer scaling only, nearest-neighbour filtering, no mipmaps, no compression that blurs pixels.
- **Resolution for high-DPI:** author UI and HUD art at 2x or 3x, or as vectors, as agreed with the UI builder.
- **App icons and store art are joint work with the UI builder,** who owns the visual design. You produce the files at required sizes: Apple's App Store icon at 1024x1024 px with no transparency; Google Play's icon at 512x512 px and feature graphic at 1024x500 px; Steam capsules and other storefront art at the sizes in the store's current documentation. Check each store's current requirements before export; screenshots and listing art are uploaded by the human.

---

## 9. Audio

- **Sources** are uncompressed WAV (48 kHz or 44.1 kHz, 24-bit or 16-bit) in `assets/source/audio/`. Never re-encode from a lossy file.
- **Delivery formats by engine:** WAV into Unreal, Unity and Godot (they compress on import or cook); Ogg Vorbis for Godot and web music; Opus or Ogg plus an AAC/M4A fallback for browsers that need it; the engine's own streaming settings for long music.
- **Mono for 3D-positioned sounds,** stereo for music and UI. Trim silence at the start so sounds fire on time. Music loops are sample-accurate with loop points recorded in the asset list.
- **Loudness targets** are consistent across the game. Choose and record them, for example around -16 LUFS integrated for mobile and web, around -23 to -24 LUFS for console and TV-style play, with true peak at or below -1 dBTP. Measure with ffmpeg:

```bash
ffmpeg -hide_banner -i mus_level1_loop.wav -af ebur128=peak=true -f null - 2> reports/assets/loudness/mus_level1_loop.txt
ffmpeg -i in.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -   # analysis pass for normalization
```

- **Sound effects** are balanced relative to music and voice by category rather than all normalized to the same level; record the per-category targets.
- **Voice** files need transcripts for subtitles (`helm-game` section 3); deliver them as text alongside the audio.

---

## 10. Blender, headless

Agents run Blender without a UI. Check it first:

```bash
blender --version
```

**If Blender is not installed,** say so in `helm_report` (status `progress` or `blocked`, depending on whether you can continue) and either fall back to procedural or engine primitives (greybox meshes generated in the engine, code-generated geometry in three.js or Godot, simple shapes the Core builder can use) or ask the human to install it with `helm_need` (about: `access`). Never claim an asset was made in Blender when it was not.

**Running scripts:**

```bash
# Script with no .blend file (procedural modelling, batch conversion); args after -- go to the script
blender --background --factory-startup --python assets/scripts/make_crate.py -- --out assets/source/props/prop_crate_wood_01/prop_crate_wood_01.blend

# Script operating on an existing file
blender -b assets/source/props/prop_crate_wood_01/prop_crate_wood_01.blend -P assets/scripts/export_glb.py -- --out assets/export/props/prop_crate_wood_01/prop_crate_wood_01.glb

# Make Python errors fail the process (otherwise Blender can exit 0 after a script exception)
blender -b file.blend --python-exit-code 1 -P script.py -- args
```

- **Read arguments after `--`** in the script: `argv = sys.argv[sys.argv.index("--") + 1:]` parsed with `argparse`.
- **`--factory-startup`** ignores the user's preferences and add-ons so results do not depend on the machine.
- **Command-line options run in order:** for renders, set the output path (`-o`) and format (`-F`) before `-f <frame>` or `-a`.

**bpy patterns to use:**
- Start clean: `bpy.ops.wm.read_factory_settings(use_empty=True)`.
- Build meshes with `bpy.ops.mesh.primitive_*_add`, modifiers (`obj.modifiers.new(name, 'BEVEL')`, `'DECIMATE'`, `'MIRROR'`), or directly with `bmesh` for full control. Seed any randomness so a re-run gives the same asset.
- Apply modifiers and transforms before export; set object origins with `bpy.ops.object.origin_set` or by moving geometry.
- Export: `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', use_selection=True)` and `bpy.ops.export_scene.fbx(filepath=..., use_selection=True, ...)` with axis, scale and animation options set explicitly in the script.
- Save sources: `bpy.ops.wm.save_as_mainfile(filepath=...)`.
- Operator names and options change between Blender versions. Check the Python API reference for the installed version and test on one asset before batch runs.

**Renders as evidence.** Render a preview or turntable of each final asset: a camera framing the object, a neutral three-point or HDRI light (CC0 HDRIs from Poly Haven work well), a fixed resolution such as 1024x1024, and a scale reference (a 1.8 m figure or a 1 m grid) where scale matters. Render stills with `-f`, or a short turntable as a frame range, into `reports/assets/renders/`. Use EEVEE or Workbench for speed when photorealism is not needed; set the engine in the script rather than relying on file defaults.

---

## 11. Provenance and licensing

Every file that ships must be legal to ship.

- **Record everything in `assets/LICENSES.md`:** asset ID, file paths, source (made in project, procedural script name, or URL), author, license (CC0, CC-BY 4.0, and so on), date retrieved, and any attribution text required. CC-BY assets need visible credits; tell the UI builder and Docs builder what must appear in the credits screen.
- **Good CC0 sources:** Poly Haven (models, textures, HDRIs), Kenney (game asset packs), ambientCG (PBR materials). Other sites mix licenses per asset (for example OpenGameArt, Freesound): check each file. Non-commercial (NC) and no-derivatives (ND) licenses are not acceptable for a product unless the human approves in writing via `helm_need`.
- **No ripped, extracted or unlicensed assets,** no assets from other games, no fonts or music without a license that covers embedding in software. If the license is unclear, do not use it.
- **Paid asset store packs** (Unreal Fab, Unity Asset Store, others) need human approval and the human's account: `helm_need` (about: `spending` or `access`). Record the license terms that apply.
- **AI-generated assets only if the project allows them** (SPEC or DECISIONS.md says so). Label them in `LICENSES.md` with the tool and date, and note that stores and platforms may require disclosure. If the project is silent, ask the lead.
- **Human-provided assets** are recorded with "provided by the project owner" and whatever license or terms they stated.

---

## 12. Git LFS and repository hygiene

- **Track binaries with Git LFS** before the first commit of each type: `.blend`, `.fbx`, `.glb`, `.psd`, `.kra`, `.aseprite`, `.png`, `.tga`, `.exr`, `.ktx2`, `.wav`, `.ogg`, `.mp3`, plus `.uasset` and `.umap` for Unreal. Add the patterns to `.gitattributes` (ask the lead if that file is outside your scope).
- **Do not commit** Blender autosaves and backups (`*.blend1`, `*.blend2`), temporary render folders, or engine caches.
- **Lock or announce** edits to binary files other builders also touch (`git lfs lock` where the server supports it, otherwise `helm_message` the owner).
- **Keep commits per asset or per batch** with the asset IDs in the message, so a broken asset can be reverted alone.
- **LFS storage costs** on hosted git can require a paid plan for large projects; raise it with `helm_need` (about: `spending`) before you hit the limit.

---

## 13. Import verification in the engine

An exported file is not done until the engine has imported it correctly.

- **Import with scripted, recorded settings:** Unreal Python import tasks (`helm-unreal` section 7), Unity `AssetPostprocessor` scripts or preset files, Godot `.import` files (committed, text), web loaders in a small test page.
- **Check each asset:** scale against the 1 m reference, forward direction, pivot, material slots assigned, textures with the right type and color space, normal map direction, LODs present and switching, collision present, animations play, no import warnings.
- **Validate glTF** with the Khronos glTF Validator (CLI or web) and inspect sizes with `gltf-transform inspect` if the `@gltf-transform/cli` package is available; fix every error.
- **Engine-side screenshots:** one per asset in a neutral test scene, captured headless where the engine allows it (Unreal `HighResShot`, Godot or web capture through the Core builder's tooling or `plugin:browser-automation`).
- **Budget table:** for each asset, measured triangles per LOD, texture sizes and estimated GPU memory, file size, and pass or fail against the budget. Generate it with a script (bpy can count triangles; engine scripts can read imported sizes) rather than by hand.
- **Coordinate:** when an asset is verified, message the Core builder with the asset ID, engine path, pivot and collision notes so they can reference it from data.

---

## Done means

**Planning**
- [ ] Asset list exists with ID, type, user, source, budget and status for every asset; budgets per platform recorded in ACCEPTANCE.
- [ ] Naming and folder layout followed; IDs stable; sources and exports separated.

**Production**
- [ ] Editable sources committed for every asset; exports regenerated by committed scripts.
- [ ] Scale, axes and pivots verified with the 1 m reference import; transforms applied.
- [ ] Topology clean, UVs padded with consistent texel density, LODs and collision where needed.
- [ ] PBR maps in correct color spaces, ORM packed for the engine, power-of-two sizes, normal map convention matched to the engine.
- [ ] Rigs and animations exported with stable bone and clip names, verified playing in the engine.
- [ ] Sprites, atlases and store art at the required sizes, agreed with the UI builder.
- [ ] Audio at agreed formats with measured loudness within target.

**Legal and repo**
- [ ] Every third-party or generated asset recorded in `assets/LICENSES.md` with source and license; no NC, ND, ripped or unclear files; AI assets only if allowed and labeled.
- [ ] Binaries tracked in Git LFS; no autosaves or caches committed.
- [ ] Missing tools (Blender, paid packs, accounts) reported via `helm_report` or `helm_need`, with the fallback stated.

**Verification**
- [ ] Every final asset imported in the engine with no warnings; budget table shows pass for each, or the overage is reported with a reason.
- [ ] `helm_slop_scan` clean on your files.

## Evidence to commit

Under `reports/assets/` (for example `reports/assets/<task>/`):
- `renders/<asset_id>.png` (and turntable frames where useful) with a scale reference.
- `engine/<asset_id>.png` screenshots of the imported asset in a neutral scene.
- `import-<engine>.log` from the scripted import, plus the 1 m reference cube result.
- `budget.md` (or `budget.csv`): per asset, triangles per LOD, texture sizes and estimated memory, file sizes, pass or fail.
- `loudness/<asset_id>.txt` measurements for audio.
- `gltf-validator/<asset_id>.json` reports for glTF exports.
- `ENV.txt`: Blender version (or "not installed" and the fallback used), engine version, other tools, and the exact commands run.

## Sources

- Blender Manual, Command Line Arguments: https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html
- Blender Python API: https://docs.blender.org/api/current/
- Blender Manual, glTF 2.0 add-on: https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html
- Blender Manual, FBX add-on: https://docs.blender.org/manual/en/latest/addons/import_export/scene_fbx.html
- Khronos glTF 2.0 specification: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- Khronos glTF Validator: https://github.com/KhronosGroup/glTF-Validator
- glTF Transform: https://gltf-transform.dev/
- KTX and Basis Universal: https://www.khronos.org/ktx/
- Unreal Engine, FBX content pipeline: https://dev.epicgames.com/documentation/en-us/unreal-engine/fbx-content-pipeline
- Unity Manual, Importing models: https://docs.unity3d.com/Manual/ImportingModelFiles.html
- Unity Manual, Texture formats: https://docs.unity3d.com/Manual/class-TextureImporterOverride.html
- Godot Docs, Importing 3D scenes: https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/index.html
- Arm, ASTC texture compression: https://developer.arm.com/documentation/102162/latest/
- EBU R 128 loudness recommendation: https://tech.ebu.ch/publications/r128
- FFmpeg filters (ebur128, loudnorm): https://ffmpeg.org/ffmpeg-filters.html
- Poly Haven license: https://polyhaven.com/license
- Kenney: https://kenney.nl/
- ambientCG license: https://docs.ambientcg.com/license/
- Creative Commons licenses: https://creativecommons.org/licenses/
- Git LFS: https://git-lfs.com/
- Apple Human Interface Guidelines, App icons: https://developer.apple.com/design/human-interface-guidelines/app-icons
- Google Play, Preview assets: https://support.google.com/googleplay/android-developer/answer/9866151
