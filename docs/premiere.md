# Native Adobe Premiere projects

CUT Studio can write a genuine `.prproj` project, with editable sequences, clips and tracks. This is a gzip-compressed Premiere XML object graph. It is a different export from FCP 7 interchange XML; changing a filename extension does not convert one format into the other.

```sh
cut export film.cut --output movie.prproj
# From this source checkout:
npm run cut -- export examples/layers.cut --output "examples/output/Layer study.prproj"
```

Choose **Premiere project (.prproj)** in the studio’s export menu. Open the resulting file in Premiere, then **double-click the sequence in the Project panel** to open its timeline. A freshly generated project does not automatically open its sequence tab. Premiere’s own subsequent Save command retains the current open sequence and panel state.

The export references the existing local media. Keep those assets available, and move or share the media alongside the project when relocating it. The exporter does not copy or change the source footage.

## Requirements and implementation

Native export needs **Python 3.10 or later** in addition to CUT’s usual Node/FFmpeg requirements. It uses Python’s standard library and the bundled native-format writer; there is no pip installation. macOS does not guarantee an appropriate Python version, so install a current Python from [python.org](https://www.python.org/downloads/) or with `brew install python` if needed. `CUT_PYTHON=/absolute/path/to/python3` selects a particular interpreter. Missing or old Python produces an installation message; ordinary preview, MP4 rendering and XML export remain available.

Adobe Premiere itself is not required to generate a project. The writer runs locally, does not install an Adobe plugin, does not change Premiere preferences or debug settings, and does not operate an existing Adobe project. No account or remote processing is used.

The native-format implementation vendors the MIT-licensed [py-premiere](https://github.com/Pouf/py-premiere) runtime at commit `38e72ef5d389f472183fb23c471f9c9eb79394f8`. The license and pinned source notice are shipped beside the runtime ZIP. The bundle contains the modules used for native project creation and parsing; upstream sample footage, fixtures, tests and command-line tools are excluded. CUT adds its own media/timeline adapter, standard Adobe time-display constants, native intrinsic effects and validation.

## What is preserved

| CUT feature | Native `.prproj` export |
| --- | --- |
| Film name, resolution and frame rate | Native sequence settings |
| Source paths and source trims | Editable references and in/out boundaries |
| Absolute timeline positions | Exact integer native ticks; one CUT tick maps to exactly 7,200 Premiere ticks |
| Numbered video layers | Separate native video tracks, including empty numbered gaps |
| Independent audio layers | Separate native audio tracks |
| Silent video tracks | Only video is placed; source sound appears only through explicit audio clips |
| Scaling to fit | Native Scale to Frame Size setting on video sources |
| Opacity | Editable Opacity intrinsic, in Premiere’s percentage units |
| Decibel gain | Editable Volume intrinsic, with Premiere’s normalized Level units converted correctly |
| Audio fades | Editable sampled Volume keyframes, including exact output-frame points for fades up to 512 frames |
| Named timing and scene instances | Resolved to exact sequence positions. Clips from scenes occupy individual tracks. Timing relationships are authored in CUT. |
| Position, crop, scale, stills, titles and captions | Individual ProRes 4444 picture clips with an alpha channel. Placement and clip opacity stay editable. |
| Music ducking | A PCM WAV with the attenuation applied under dialogue. Placement, static gain and fades stay editable. |

**Export…** in the Mac app and the MCP tool `cut_export_plan` show the per-clip handoff. CUT writes companion media into a separate folder beside the project. Keep this folder and the referenced originals when moving the project. Reframe or change title text in the CUT source and re-export to update that artwork. The movie format preserves transparency for layered compositing. [Apple ProRes 4444](https://support.apple.com/en-us/102207)

The exporter supports clip gain through **+15 dB**. Higher boosts are rejected with a message to bake the gain into a new audio asset, rather than silently changing the requested level. Gains and fades on multichannel sources beyond mono/stereo are also rejected; bake a stereo audio asset when those effects are needed.

Premiere interpolates its native Volume control differently from FFmpeg’s linear-amplitude fade. CUT therefore exports sampled envelope points: 64 subdivisions per fade, plus output-frame points for fades up to 512 frames. These remain editable. There can be a small difference between keys; each export containing fades reports that limitation. Overlapping fades use an additional sampled approximation of their multiplied envelope.

The native media importer deliberately accepts known codec/container profiles rather than guessing their object graphs. H.264/H.265/ProRes/DNxHR MP4 or MOV and PCM WAV are useful inputs; other supported upstream profiles include AIFF, M4A, MP3, AAC, WMA, AVI and MPEG-2 MXF. An unsupported source profile produces a file-specific error and suggests FCP 7 XML or transcoding to compatible local media. Broad codec availability in CUT’s FFmpeg renderer does not imply every codec can be written into a native Premiere project by this adapter.

## Validation and its meaning

Every successful native export is reopened with the bundled native-format parser before the temporary output atomically replaces the requested destination. Validation checks sequence dimensions and timebase, every clip’s source in/out and timeline start/end, opacity values, and gain/fade keyframe values. The TypeScript result `{verified: true, verification: 'native-roundtrip'}` refers to these checks. It does **not** mean Premiere is launched for every export.

The implementation was also tested in the actual **Adobe Premiere Pro 2026, version 26.5.2**, installed on this Mac. The concrete deliverable `examples/output/Layer study.prproj` was opened, its sequence double-clicked, inspected and saved by Premiere. Verification observed:

- Five media assets online, with a 12-second, 960×540, 24 fps sequence.
- Three editable video lanes, with V2 empty and the translucent clip on V3.
- Two independent audio lanes and five timeline clips, with the intended trims and placements.
- The overlay’s Opacity control at **35%**.
- The audio Volume controls at **−6.0 dB** and **−12.0 dB** after their fades.
- The first track’s exact half-second fade position at **−12.0 dB** in Premiere’s display, agreeing with half amplitude of a −6 dB clip (−12.0206 dB before display rounding).
- Successful native Save and subsequent parsing of the Adobe-saved file, preserving the sequence, tracks, media and editable envelopes.

The native project format is Adobe’s proprietary implementation format, rather than a public interchange standard. The actual application check above establishes compatibility with the tested version and inputs. A project using another codec or a materially different Premiere version still warrants opening and reviewing it before delivery.

## XML remains available

```sh
cut export film.cut --output sequence.xml
```

The FCP 7 XML exporter is useful for other editors and media that the native writer cannot describe. See [the interchange notes](interchange.md) for its limitations. XML export currently preserves cuts, track/layer placement and source references; opacity, gain and fades require baking when exact visual/audio output must be retained through that interchange route.
