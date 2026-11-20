import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { compile } from '../src/core/compiler';
import type { Timeline } from '../src/core/types';
import { exportPremiere } from '../src/exporters/premiere';

let directory: string, timeline: Timeline;
const python = process.env.CUT_PYTHON || 'python3';
const source = `film "Native layers" { resolution 320x180 fps 24
  track video "Overlay" layer 3 { clip "red.mp4" { in 0.25s out 0.75s at 0.5s opacity 0.4 } }
  track video "Picture" layer 1 { clip "red.mp4" from 0.5s to 1.5s at 0s }
  track audio "Score" { clip "tone.wav" { in 0.25s out 1.25s at 0.125s gain -6dB fade_in 0.5s fade_out 0.25s } }
  track audio "Accent" { clip "tone.wav" { in 0s out 1s at 0s gain -12dB } }
}`;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cut-native-premiere-'));
  const ffmpeg = process.env.CUT_FFMPEG || 'ffmpeg';
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','color=c=red:s=160x90:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p','-y',path.join(directory,'red.mp4')]);
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-af','pan=stereo|c0=c0|c1=c0','-c:a','pcm_s16le','-y',path.join(directory,'tone.wav')]);
  const result = await compile(source,path.join(directory,'film.cut')); expect(result.diagnostics.filter(d=>d.severity==='error')).toEqual([]); timeline=result.timeline!;
});
afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
const inspect = (file: string) => JSON.parse(execFileSync(python,['-I','-c',`
import sys,json
sys.path.insert(0,sys.argv[1]);import py_premiere
s=py_premiere.parse(sys.argv[2]).project.sequences[0]
def clip(c):
 return {'at':c.start.ticks,'end':c.end.ticks,'in':c.in_point.ticks,'out':c.out_point.ticks,'scale':c.project_item.scale_to_frame_size,'components':[{'name':x.display_name,'match':x.match_name,'params':[{'name':p.display_name,'value':p.value,'keys':[[k.ticks,p.get_value_at_key(k)]for k in p.keys]}for p in x.properties]}for x in c.components]}
print(json.dumps({'name':s.name,'size':s.frame_size,'timebase':s.timebase,'video':[[clip(c)for c in t.clips]for t in s.video_tracks],'audio':[[clip(c)for c in t.clips]for t in s.audio_tracks]}))
`,path.resolve('resources/premiere/py-premiere.zip'),file],{encoding:'utf8'}));

describe('genuine native Premiere project exporter',()=>{
  it('creates a gzip Premiere object graph with exact trims, numbered layers, opacity and audio envelopes',async()=>{
    const output=path.join(directory,'native.prproj'),progress:number[]=[];
    const result=await exportPremiere(timeline,{output,onProgress:p=>progress.push(p.fraction)});
    expect(result.verified).toBe(true);expect(result.verification).toBe('native-roundtrip');expect(progress.at(-1)).toBe(1);
    const xml=gunzipSync(await readFile(output)).toString('utf8');expect(xml).toContain('<PremiereData');expect(xml).not.toContain('<xmeml');
    const info=inspect(output);expect(info.size).toEqual([320,180]);expect(info.timebase).toBe(10_584_000_000);expect(info.video).toHaveLength(3);expect(info.video[1]).toEqual([]);expect(info.audio).toHaveLength(2);
    expect(info.video[0][0]).toMatchObject({at:0,in:127008000000,out:381024000000,end:254016000000,scale:true});
    const opacity=info.video[2][0].components.flatMap((c:any)=>c.params).find((p:any)=>p.name==='Opacity');expect(opacity.value).toBeCloseTo(40,5);
    const level=info.audio[0][0].components.flatMap((c:any)=>c.params).find((p:any)=>p.name==='Level');
    const half=level.keys.find((k:number[])=>k[0]===127008000000);expect(half).toBeDefined();expect(20*Math.log10(half[1])+15).toBeCloseTo(-12.0205999,5);
    const staticLevel=info.audio[1][0].components.flatMap((c:any)=>c.params).find((p:any)=>p.name==='Level');expect(20*Math.log10(staticLevel.value)+15).toBeCloseTo(-12,5);
    expect(result.warnings.join(' ')).toContain('interpolation between keys');
  });
  it('rejects unsupported high native gain and preserves an existing destination',async()=>{
    const high=await compile(source.replace('gain -12dB','gain 16dB'),path.join(directory,'film.cut'));const output=path.join(directory,'native.prproj'),before=await readFile(output);
    await expect(exportPremiere(high.timeline!,{output})).rejects.toThrow('up to +15 dB');expect(await readFile(output)).toEqual(before);
    expect((await readdir(directory)).some(file=>file.startsWith('.native.'))).toBe(false);
  });
  it('protects referenced source files through output aliases and supports cancellation',async()=>{
    const output=path.join(directory,'source-alias.prproj');await symlink(path.join(directory,'red.mp4'),output);
    await expect(exportPremiere(timeline,{output})).rejects.toThrow('must not overwrite');
    const controller=new AbortController();controller.abort();await expect(exportPremiere(timeline,{output:path.join(directory,'cancelled.prproj'),signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  });
  it('reports missing Python with actionable guidance',async()=>{
    await expect(exportPremiere(timeline,{output:path.join(directory,'no-python.prproj'),pythonPath:path.join(directory,'missing-python')})).rejects.toThrow('Python 3.10 or later');
  });
});
