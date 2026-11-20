# Timeline interchange

CUT's resolved timeline keeps track order, kinds, source paths, integer-tick source/timeline boundaries, film rate/resolution and supported effects independently of VS Code. `TimelineExporter` accepts this immutable model and returns content plus explicit warnings. Exporters must not silently imply an unsupported property has transferred.

## Native Premiere Pro project

Use **Export… → Premiere Pro project (.prproj)** in the Mac app. The CLI equivalent is `cut export film.cut --output film.prproj`. The native writer builds an editable project with numbered video and audio lanes and references to the original media. Detailed format support and verification are recorded in [Premiere export](premiere.md).

## FCP 7 XML

`cut export film.cut --output sequence.xml` writes version-5 `xmeml`, the Final Cut Pro 7 interchange family. This is distinct from modern `.fcpxml`; [Adobe says Premiere does not directly import Final Cut Pro X FCPXML](https://helpx.adobe.com/uk/premiere/desktop/organize-media/import-files/migrate-from-final-cut-pro-x.html).

The exporter follows Apple's [Elements Catalog](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html) and [encoding conventions](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Basics/Basics.html): media references use file URLs, clipitem start/end describe sequence positions, in/out describe source frames, and rates use integer timebase plus an NTSC flag. Unsupported nonstandard fractional rates are rejected instead of mislabeled.

| CUT property | XML behavior |
| --- | --- |
| Film name, rate, output dimensions | Exported |
| Video/audio track separation and order | Exported; track names included as XML comments |
| Source path and trims | Exported as file URL + source-frame in/out |
| Timeline placement, gaps, clip ends | Exported as sequence-frame start/end |
| Audio sample positions | Rounded to sequence frames, with a warning |
| Mixed source/output FPS | Rates described; receiving-editor conform must be checked |
| Video opacity | Warning; bake matching video layers if required |
| Audio gain and fades | Warning; bake the audio mix if required |
| Scaling/letterbox and color handling | Receiving-editor defaults may differ; bake for exact appearance |

The original media must remain accessible. Structural tests validate XML and timing values. An actual Premiere import and playback has not been certified by those tests. Adobe's [FCP XML export guidance](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html) also cautions that effects and audio parameters can translate incompletely.

## OpenTimelineIO investigated, not bundled

The [OpenTimelineIO adapter documentation](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/docs/tutorials/adapters.md) lists interchange adapters as community projects. The [FCP adapter](https://github.com/OpenTimelineIO/otio-fcp-adapter) provides an alternative FCP 7 route, but introduces a Python runtime and adapter/version management. It is unnecessary for the present direct, minimal XML output.

A later OTIO exporter can implement the same CUT `TimelineExporter` interface. Source ranges, track stacks and media references map naturally. Unsupported effects still need explicit metadata or baking; installing OTIO alone does not guarantee Premiere-compatible behavior.
