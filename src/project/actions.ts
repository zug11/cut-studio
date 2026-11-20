import * as z from 'zod/v4';
import { ProjectSession } from '../mcp/project';
import { editSchema } from './edits';
import type { ReviewMedia } from './review';

const file = z.string().min(1).max(4096);
const source = z.string().max(2 * 1024 * 1024);
const doc = { file, source: source.optional() };
export const sceneSourcesSchema = z.record(file, source).refine((drafts) => {
  const texts = Object.values(drafts);
  return (
    texts.length <= 64 &&
    texts.reduce((n, t) => n + Buffer.byteLength(t), 0) <= 2 * 1024 * 1024
  );
}, 'Use at most 64 draft scene files totalling 2 MB.');
const reviewDoc = { ...doc, sceneSources: sceneSourcesSchema.optional() };
export const studioActions = {
  cut_review: {
    title: 'Review a cut or compare two versions',
    description:
      'Play up to 15 seconds around a time or named cue, with a timecoded contact sheet, sound and local movie. Supply alternateFile and/or alternateSource to compare both at the same cue. embedMovie also embeds the movie for clients that accept video resources. sceneSources and alternateSceneSources preview project-relative child drafts in either version without saving them.',
    schema: z
      .object({
        ...reviewDoc,
        cue: z.string().max(160).optional(),
        seconds: z.number().positive().max(15).optional(),
        alternateFile: file.optional(),
        alternateSource: source.optional(),
        alternateSceneSources: sceneSourcesSchema.optional(),
        embedMovie: z.boolean().optional()
      })
      .strict()
  },
  cut_contact_sheet: {
    title: 'Browse frames from a take',
    description:
      'Return sampled source frames as a labelled image with source timecodes. Use cut_audition to play a chosen moment.',
    schema: z
      .object({ file, count: z.number().int().min(1).max(12).optional() })
      .strict()
  },
  cut_audition: {
    title: 'Audition source footage or audio',
    description:
      'Play a source excerpt. from and seconds are source seconds. Returns available sound, picture and a local movie.',
    schema: z
      .object({
        file,
        from: z.number().nonnegative().optional(),
        seconds: z.number().positive().max(15).optional(),
        embedMovie: z.boolean().optional()
      })
      .strict()
  },
  cut_search_dialogue: {
    title: 'Search or index spoken dialogue',
    description:
      'Search timed SRT/VTT sidecars and cached local transcripts. Specify index:true to transcribe the chosen take or all project takes on this computer. First use downloads a verified 78 MB Whisper model. Returns source ranges for auditioning.',
    schema: z
      .object({
        query: z.string().max(1024),
        file: file.optional(),
        index: z.boolean().optional()
      })
      .strict()
  },
  cut_edit: {
    title: 'Edit a shot or scene',
    description:
      'Propose one operation or an ordered batch of up to 64 operations on one CUT document. A batch commits once and returns named timing deltas, including linked followers. Use clip name or id from cut_timeline. Times accept 3s or 72f. place/insert at accepts after shot or shot.start - 8f. Trim frames are signed changes to a source boundary. close_gap takes V1/A1 lane names. Assets are project-relative. apply:true requires an exact expectedRevision and returns an undo payload for cut_save_source.',
    schema: z
      .object({
        ...doc,
        operation: editSchema.optional(),
        operations: z.array(editSchema).min(1).max(64).optional(),
        apply: z.boolean().optional(),
        expectedRevision: z.string().length(64).optional()
      })
      .strict()
  },
  cut_export_plan: {
    title: 'Inspect Premiere export',
    description:
      'Report editable timeline properties and the specific individual layers that need rendered companion media for this CUT film.',
    schema: z.object(reviewDoc).strict()
  }
} as const;
export type ActionName = keyof typeof studioActions;
export interface ActionResponse {
  data: Record<string, unknown>;
  reviews?: { label: string; media: ReviewMedia }[];
  embedMovie?: boolean;
}
export async function runStudioAction(
  project: ProjectSession,
  name: ActionName,
  input: unknown,
  signal: AbortSignal
): Promise<ActionResponse> {
  switch (name) {
    case 'cut_review': {
      const p = studioActions[name].schema.parse(input);
      const first = await project.review({ ...p, signal });
      const reviews = [{ label: p.file, media: first }];
      if (
        p.alternateFile ||
        p.alternateSource !== undefined ||
        p.alternateSceneSources
      ) {
        const file = p.alternateFile || p.file;
        reviews.push({
          label: file === p.file ? 'Alternative' : file,
          media: await project.review({
            file,
            source: p.alternateSource,
            sceneSources: p.alternateSceneSources,
            cue: p.cue,
            seconds: p.seconds,
            signal
          })
        });
      }
      return {
        data: { cue: p.cue || '0s' },
        reviews,
        embedMovie: p.embedMovie
      };
    }
    case 'cut_contact_sheet': {
      const p = studioActions[name].schema.parse(input);
      return {
        data: { file: p.file },
        reviews: [
          { label: p.file, media: await project.sheet(p.file, p.count, signal) }
        ]
      };
    }
    case 'cut_audition': {
      const p = studioActions[name].schema.parse(input);
      return {
        data: { file: p.file },
        reviews: [
          {
            label: p.file,
            media: await project.audition(p.file, p.from, p.seconds, signal)
          }
        ],
        embedMovie: p.embedMovie
      };
    }
    case 'cut_search_dialogue': {
      const p = studioActions[name].schema.parse(input);
      return { data: await project.dialogue(p.query, p.file, p.index, signal) };
    }
    case 'cut_edit':
      return {
        data: await project.edit({
          ...studioActions[name].schema.parse(input),
          signal
        })
      };
    case 'cut_export_plan':
      return {
        data: await project.exportPlan({
          ...studioActions[name].schema.parse(input),
          signal
        })
      };
  }
}
