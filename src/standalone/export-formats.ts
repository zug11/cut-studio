export const exportFormats = {
  prproj: { name: 'Premiere Pro project', detail: 'An editable sequence linked to your original media.' },
  drp: { name: 'DaVinci Resolve 21 project', detail: 'Editable cuts and tracks. CUT renders affected clips separately to preserve their graphics and mix.' },
  mp4: { name: 'MP4 movie', detail: 'A finished H.264 movie with the CUT picture and audio mix.' },
  xml: { name: 'Final Cut Pro 7 XML', detail: 'An interchange sequence for importing into another editor.' }
} as const;

export type ExportFormat = keyof typeof exportFormats;

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && Object.hasOwn(exportFormats, value);
}
