# ps-scripts — standalone Photoshop retouching scripts

Recreated from the CEP-panel bundles in `~/jsx` (a 2014–2017 beauty-retouching
panel). Each `$._ext_NAME = { run: function() { ... } }` module was unwrapped
into its own standalone ExtendScript file that runs directly in Photoshop —
no CEP extension required. The ActionManager code is byte-identical to the
originals (all 521 `executeAction` calls preserved); only the panel wrapper and
CEP-only persistence code (`csInterface` / `CSEvent`) were removed.

## Layout

One folder per source file, one script per module. `manifest.json` lists every
script with its source file and original module key — use it to enumerate the
scripts from your app.

| Folder | Contents |
| --- | --- |
| `Dodge/`, `Burn/` | Select the Dodge/Burn curves layer and reset colors |
| `DodgeIntensity/`, `BurnIntensity/` | Set Dodge/Burn layer opacity, 10–100% (10 scripts each) |
| `AutomaticDodgeandBurn/`, `DodgeandBurnManual/` | Build the dodge & burn curves-layer setup |
| `ManualDodgeandBurnBackButton/` | Merge the manual D&B result back to one layer |
| `SkinSmoothing/` | High-pass smart-filter radius: VeryLow(1) Low(3) Medium(5) High(7) VeryHigh(10) Insane(20) |
| `SkinTexture/` | Gaussian-blur smart-filter radius: VeryLow(1) Low(3) Medium(5) High(7) VeryHigh(10) |
| `AdvancedRetouching/` | Inverted-high-pass skin retouch layer with hide-all mask |
| `CreateBlemishRemovalLayer/`, `CreateBlushonLayer/`, `CreateEyeColorLayer/`, `CreateEyeshadeLayer/`, `CreateHairColorLayer/`, `CreateLipstickLayer/` | Makeup paint layers (blend mode, blend-if, brush + color presets) |
| `Photoshop/` | The panel's main bundle: retouch layer, teeth whitening, eye enhancement, lip color/gloss, skin looks, opacity presets, and ~25 one-click color/film effects |

## Running the scripts

- **In Photoshop:** File → Scripts → Browse…, or drop a script onto the app.
- **From your own app (macOS):**

  ```sh
  osascript -e 'tell application id "com.adobe.Photoshop" to do javascript of file "/path/to/script.jsx"'
  ```

  From Node/Electron, spawn that `osascript` command (or use `do javascript`
  with the script text inlined).

## Caveats (inherited from the originals)

- These are recorded actions: most assume a specific document state (e.g. a
  layer literally named "Dodge", "Burn", or a selected smart-filter stack
  created by the corresponding setup script). Run the setup script first.
- A few scripts pass recorded numeric layer IDs (`LyrI` lists) alongside layer
  names; the name lookup is what matters, and the stale IDs are harmless in
  current Photoshop versions but are kept verbatim for fidelity.
- Brush selection steps expect the default "Soft Round" / "Hard Round" brush
  presets to exist.
- Scripts run with `DialogModes.NO` (no UI) except the few that intentionally
  open a picker/dialog.
