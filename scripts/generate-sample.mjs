import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'examples', 'media');
await mkdir(directory, { recursive: true });
const executable = process.env.CUT_FFMPEG || 'ffmpeg';
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { shell: false });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errors || `FFmpeg exited ${code}`)));
  });
}
const sources = [
  ['dawn.mp4', 'gradients=s=960x540:r=24:c0=0x152938:c1=0xd59c72:c2=0x334e62:n=3:type=radial:speed=0.08:seed=11:d=9'],
  ['current.mp4', 'gradients=s=960x540:r=24:c0=0x0f303c:c1=0x75b9b0:c2=0x1c596b:n=3:type=spiral:speed=0.12:seed=22:d=9'],
  ['light.mp4', 'gradients=s=960x540:r=24:c0=0x252744:c1=0xf0bda2:n=2:type=circular:speed=0.16:seed=33:d=5']
];
for (const [name, source] of sources) {
  console.log(`Generating ${name}…`);
  await run(['-f', 'lavfi', '-i', source, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(directory, name)]);
}
console.log('Generating two independent audio tracks…');
await run(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=12', '-af', 'volume=0.5', '-c:a', 'pcm_s16le', path.join(directory, 'tone-low.wav')]);
await run(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=7', '-af', 'tremolo=f=2:d=0.35,volume=0.4', '-c:a', 'pcm_s16le', path.join(directory, 'tone-high.wav')]);
console.log(`Sample media is ready in ${directory}\nTry: npm run cut -- check examples/signal.cut`);
