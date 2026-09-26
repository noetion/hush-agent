# Interface decisions

Hush sits over whatever you are already doing, so the panel has to read as something that belongs on top of another activity rather than as a utility window competing with it. An early opaque panel failed that: correct, and wrong in the room.

## The surface

A rounded smoked-glass shell with a thin light edge, quiet segmented navigation and a translucent composer. Text is opaque and sits above the tint, so translucency never costs legibility.

The panel is 390 × 500 logical pixels, about a quarter less area than the first version. The cue is 276 × 62. DPI rounding can move measured bounds slightly.

Colours are cool-neutral ink with a pale silver action button. The typeface follows the host. Supporting labels are at least 11px and conversation text is 13px. Keyboard focus is always explicit, reduced-motion turns off hover transitions, and a request for increased contrast switches to an opaque surface. Hidden remains the normal state.

## Translucency, per platform

- **Windows 11** (build 22621 and later) uses Electron's acrylic material.
- **Windows 10** uses a small one-shot helper that applies the undocumented `SetWindowCompositionAttribute` blur accent to Hush's own two window handles. It starts no service and reads nothing from the screen. Because that API is undocumented, the helper is tested at runtime and an opaque surface is kept as the fallback.
- **macOS** uses its own HUD vibrancy.
- **Linux** has no portable equivalent in Electron and uses the opaque surface.

Native window shaping was removed after it caused clipping on mixed-DPI setups and stalls during capture. The renderer owns the rounded tinted surface instead, so the compositor blur spans the native rectangle including the transparent corners.

## Receding

Left alone the panel fades, then rolls up to a single status bar, and lets clicks through to whatever is behind it. Two depths rather than one: a faded panel still shows a conversation worth glancing at, while a rolled-up bar has one line and nothing to act on, so it can sink further.

Drafts extend the idle delay to four seconds before dimming and twelve before collapsing. Dictation and a waiting decision keep it awake. Active hovering also keeps it awake; a parked pointer stops doing so after twelve seconds.

## How this is checked

The self-test drives the real windows and captures the actual compositor output over bright and dark backgrounds. Those are controlled scenes: they show the effect works, not that it looks right in any particular game. Captures stay local and are excluded from the repository. Renderer checks in a browser exercise the controls only, since a browser cannot demonstrate desktop blur.

References: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) and the [Windows App SDK discussion](https://github.com/microsoft/WindowsAppSDK/discussions/2711) on composition attributes.
