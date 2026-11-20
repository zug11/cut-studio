import type { Timeline } from '../core/types';
export interface ExportResult {
  contents: string;
  warnings: string[];
}
/** Exporters translate an immutable resolved timeline. Unsupported effects must be reported. */
export interface TimelineExporter {
  readonly id: string;
  readonly extension: string;
  export(timeline: Timeline): ExportResult;
}
export { fcp7Exporter, exportFcp7 } from './fcp7';
