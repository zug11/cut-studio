#!/usr/bin/env python3
"""CUT's isolated native Premiere writer. Uses the pinned MIT runtime beside this file."""
import sys
if sys.version_info < (3, 10):
    sys.stderr.write('Python 3.10 or later is required for native Premiere export.\n')
    sys.exit(2)
import copy
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET
sys.path.insert(0, str(Path(__file__).with_name('py-premiere.zip')))
import py_premiere
from py_premiere import Time
from py_premiere.enums import BlendMode, KeyframeInterpolation
from py_premiere.models.sequence_builder import FORMATS, SequenceFormat
from py_premiere.models.component import Component, ComponentParam
from py_premiere.models.media_import import TIMECODE_FORMATS, MOVIE_STREAM_PROFILES

# The companion encoder emits standard Apple ProRes 4444 (ap4h) with straight alpha.
# Premiere reads alpha from the media. Use the ProRes stream descriptor and leave
# IgnoreAlpha unset so the lower video tracks are visible.
MOVIE_STREAM_PROFILES.setdefault(("mov", "ap4h"), MOVIE_STREAM_PROFILES[("mov", "apch")])
# Adobe Time display-format constants; native-open QA covers the 24 fps profile.
TIMECODE_FORMATS.update({(10584000000, False): 100, (10594584000, False): 110,
                        (8467200000, False): 104, (5080320000, False): 105,
                        (4233600000, False): 108, (4237833600, False): 107})

CUT_TICKS = 35280000
NATIVE_FACTOR = 7200  # Exact: Premiere's 254016000000 ticks/sec / CUT's 35280000.
def native(value): return Time(int(value) * NATIVE_FACTOR)
def progress(fraction, message): print(json.dumps({'type': 'progress', 'fraction': fraction, 'message': message}), flush=True)
def leaf(element, name, value):
    child = ET.SubElement(element, name); child.text = str(value); return child

def materialize_volume(placed, channels):
    """The same intrinsic graph stored by Premiere's mono/stereo Volume effect."""
    if channels not in (1, 2): raise ValueError('Native gain/fades currently support mono or stereo audio. Export multichannel gain as baked stereo media or use XML.')
    document = placed.track.sequence.project._document
    chain = document.resolve(placed._element.find('ClipTrackItem/ComponentOwner/Components'))
    for tag in ('DefaultVol', 'DefaultVolumeComponentID'):
        element = chain.find(tag)
        if element is not None: chain.remove(element)
    mute = ET.Element('AudioComponentParam', {'ObjectID': '', 'ClassID': '32657501-3aa4-445f-a49b-d09ecb9fa1ae', 'Version': '10'})
    leaf(mute, 'IsTimeVarying', 'false'); leaf(mute, 'Name', 'Mute'); leaf(mute, 'RangeLocked', 'false')
    level = ET.Element('AudioComponentParam', {'ObjectID': '', 'ClassID': 'a714635e-a628-4b27-9d59-77eba47dbc1a', 'Version': '10'})
    for name, value in [('StartKeyframe', '-91445760000000000,1.,0,0,0,0,0,0'), ('CurrentValue', '1'), ('IsTimeVarying', 'false'), ('Name', 'Level'), ('UnitsString', 'dB')]: leaf(level, name, value)
    ids = [document.add_object(mute), document.add_object(level)]
    effect = ET.Element('AudioFilterComponent', {'ObjectID': '', 'ClassID': 'd77a90a0-6c9e-44bf-9b20-de8c21168fe1', 'Version': '4'})
    audio = ET.SubElement(effect, 'AudioComponent', {'Version': '3'}); component = ET.SubElement(audio, 'Component', {'Version': '7'}); params = ET.SubElement(component, 'Params', {'Version': '1'})
    for index, identifier in enumerate(ids): ET.SubElement(params, 'Param', {'Index': str(index), 'ObjectRef': identifier})
    leaf(component, 'ID', '1'); leaf(component, 'Intrinsic', 'true'); leaf(audio, 'FrameRate', '5292000')
    layout = [0] if channels == 1 else [100, 101]
    leaf(audio, 'AudioChannelLayout', json.dumps([{'channellabel': channel} for channel in layout], separators=(',', ':')))
    leaf(audio, 'ChannelType', 0 if channels == 1 else 1); leaf(audio, 'AudioComponentType', '0')
    leaf(effect, 'FilterPreset', '0'); leaf(effect, 'FilterMatchName', 'Internal Volume Mono' if channels == 1 else 'Internal Volume Stereo'); leaf(effect, 'FilterIndex', '-1')
    label = 'Mono' if channels == 1 else 'Stereo'; channel_type = 0 if channels == 1 else 1
    config = {'in': [{'layout': layout, 'name': label + ' In', 'type': channel_type}], 'out': [{'layout': layout, 'name': label + ' Out', 'type': channel_type}]}
    leaf(effect, 'ChannelConfigData', json.dumps(config, separators=(',', ':')))
    effect_id = document.add_object(effect)
    inner = chain.find('ComponentChain'); holder = inner.find('Components')
    if holder is None: holder = ET.SubElement(inner, 'Components', {'Version': '1'})
    ET.SubElement(holder, 'Component', {'Index': str(len(holder)), 'ObjectRef': effect_id})
    result = Component(effect, placed)
    for node in (mute, level): result._properties.append(ComponentParam(node, document, result))
    placed._components.append(result)
    return result.properties[1]

def place(track, item, clip):
    # Set temporary panel marks before placing, so native cached sequence lengths never grow to untrimmed source lengths.
    originals = []
    for template in item._clip_elements:
        core = template.find('Clip')
        if core is None: continue
        for tag, value in [('InPoint', native(clip['in']).ticks), ('OutPoint', native(clip['out']).ticks)]:
            current = core.find(tag); originals.append((core, tag, copy.deepcopy(current)))
            if current is None:
                current = ET.Element(tag); anchor = core.find('ClipID'); core.insert(list(core).index(anchor) if anchor is not None else len(core), current)
            current.text = str(value)
    try: placed = track.add_clip(item, native(clip['at']))
    finally:
        for core, tag, original in originals:
            current = core.find(tag)
            if current is not None: core.remove(current)
            if original is not None: core.append(original)
    placed.in_point = native(clip['in']); placed.out_point = native(clip['out']); placed.end = native(clip['end'])
    return placed

def build(timeline, target, work):
    warnings = []
    prefs = work / 'factory-prefs.xml'
    prefs.write_text('<PremiereData><Preferences ObjectID="1"><Properties/></Preferences></PremiereData>', encoding='utf-8')
    app = py_premiere.new(preferences_path=prefs); project = app.project
    videos = [track for track in timeline['tracks'] if track['kind'] == 'video']; audios = [track for track in timeline['tracks'] if track['kind'] == 'audio']
    num, den = timeline['fps']['num'], timeline['fps']['den']; numerator = 254016000000 * den; frame = (numerator * 2 + num) // (num * 2)
    if numerator % num: warnings.append('The output rate needs sub-tick rounding in Premiere; verify frame boundaries after import.')
    display = {(24, 1): 100, (25, 1): 101, (30, 1): 104, (50, 1): 105, (60, 1): 108, (24000, 1001): 110, (30000, 1001): 103, (60000, 1001): 107}.get((num, den), 109)
    FORMATS['cut-studio'] = SequenceFormat(frame, timeline['resolution']['width'], timeline['resolution']['height'], display, audio_tracks=max(1, len(audios)), video_tracks=max(1, len(videos)))
    sequence = project.add_sequence(timeline['name'], 'cut-studio', video_tracks=max(1, len(videos)))
    paths = list(dict.fromkeys(clip['absolutePath'] for track in timeline['tracks'] for clip in track['clips']))
    progress(0.1, 'Reading local media for native Premiere project')
    imported = {}
    for index, source in enumerate(paths):
        try: item = project.import_files([source])[0]
        except Exception as error: raise ValueError('Native Premiere media import failed for ' + source + ': ' + str(error) + '. Use FCP 7 XML or transcode this asset to H.264/ProRes MP4/MOV or PCM WAV.') from error
        if any(track['kind'] == 'video' and any(clip['absolutePath'] == source for clip in track['clips']) for track in timeline['tracks']): item.scale_to_frame_size = True
        imported[source] = item
        progress(0.1 + (index + 1) / max(1, len(paths)) * 0.35, 'Importing ' + Path(source).name)
    expected = []; total = sum(len(track['clips']) for track in timeline['tracks']); count = 0
    for kind, tracks, native_tracks in [('video', videos, sequence.video_tracks), ('audio', audios, sequence.audio_tracks)]:
        for index, source_track in enumerate(tracks):
            track = native_tracks[index]
            # The writer's track-name API is read-only. Premiere's native graph uses the Name property on the track core.
            track_core = track._element.find('ClipTrack/Track')
            if track_core is None: track_core = track._element
            node = track_core.find('Node')
            if node is None: node = ET.SubElement(track_core, 'Node', {'Version': '1'})
            properties = node.find('Properties')
            if properties is None: properties = ET.SubElement(node, 'Properties', {'Version': '1'})
            leaf(properties, 'MZ.TrackName', source_track['name'])
            for clip in sorted(source_track['clips'], key=lambda clip: clip['at']):
                placed = place(track, imported[clip['absolutePath']], clip)
                if kind == 'video' and clip.get('opacity', 1) != 1:
                    placed._materialize_opacity(BlendMode.NORMAL)
                    placed.components[-1].properties[0].value = float(clip['opacity'] * 100)
                if kind == 'audio' and (clip.get('gain', 0) or clip.get('fadeIn', 0) or clip.get('fadeOut', 0)):
                    if clip.get('gain', 0) > 15:
                        raise ValueError('Native Premiere export supports clip gain up to +15 dB. Bake higher gain into a new audio asset before exporting; the CUT source is unchanged.')
                    # Premiere's normalized Level=1 represents +15 dB, not unity gain.
                    param = materialize_volume(placed, int(clip['media'].get('channels') or 1)); amplitude = 10 ** ((clip.get('gain', 0) - 15) / 20)
                    param.value = float(amplitude)
                    fade_in, fade_out, duration = clip.get('fadeIn', 0), clip.get('fadeOut', 0), clip['duration']
                    if fade_in or fade_out:
                        points = {0, duration}
                        if fade_in:
                            for part in range(65): points.add(round(fade_in * part / 64))
                        if fade_out:
                            for part in range(65): points.add(duration - fade_out + round(fade_out * part / 64))
                        # Adobe interpolates its normalized Volume control nonlinearly. Add exact
                        # output-frame points to retain CUT's linear-amplitude fade at video frames.
                        for start, length in [(0, fade_in), (duration - fade_out, fade_out)]:
                            frames = math.ceil(length * num / (CUT_TICKS * den))
                            if 0 < frames <= 512:
                                for frame_index in range(frames): points.add(start + min(length, (frame_index * CUT_TICKS * den * 2 + num) // (num * 2)))
                        warnings.append('Audio fades are editable sampled volume envelopes. Premiere interpolation between keys can differ slightly from FFmpeg linear-amplitude fades.')
                        if fade_in + fade_out > duration:
                            for part in range(1, 64): points.add(round(duration * part / 64))
                            warnings.append('Overlapping fades on ' + clip['path'] + ' use a 64-segment editable approximation of the multiplied fade envelope.')
                        def envelope(offset): return amplitude * min(1, offset / fade_in if fade_in else 1) * min(1, (duration - offset) / fade_out if fade_out else 1)
                        param.set_keyframes([(native(clip['in'] + offset), float(envelope(offset)), KeyframeInterpolation.LINEAR) for offset in sorted(points)])
                expected.append((kind, index, clip)); count += 1
                progress(0.45 + count / max(1, total) * 0.4, 'Writing editable clips and tracks')
    sequence.work_area_in = Time(0); sequence.work_area_out = native(timeline['duration']); sequence.playhead = Time(0)
    project.save(target)
    progress(0.9, 'Validating native project structure')
    reopened = py_premiere.parse(target)
    actual_sequence = reopened.project.sequences[0]
    if actual_sequence.frame_size != (timeline['resolution']['width'], timeline['resolution']['height']) or actual_sequence.timebase != frame: raise ValueError('Native sequence settings did not round-trip.')
    for kind, index, clip in expected:
        tracks = actual_sequence.video_tracks if kind == 'video' else actual_sequence.audio_tracks
        found = [item for item in tracks[index].clips if item.start.ticks == native(clip['at']).ticks and item.end.ticks == native(clip['end']).ticks and item.in_point.ticks == native(clip['in']).ticks and item.out_point.ticks == native(clip['out']).ticks]
        if len(found) != 1: raise ValueError('Native source trim or placement did not round-trip: ' + clip['path'])
        placed = found[0]
        if kind == 'video' and clip.get('opacity', 1) != 1:
            opacity = next(param for component in placed.components for param in component.properties if param.display_name == 'Opacity')
            if abs(opacity.value - clip['opacity'] * 100) > 0.00001: raise ValueError('Native opacity did not round-trip.')
        if kind == 'audio' and (clip.get('gain', 0) or clip.get('fadeIn', 0) or clip.get('fadeOut', 0)):
            level = next(param for component in placed.components for param in component.properties if param.display_name == 'Level')
            amplitude = 10 ** ((clip.get('gain', 0) - 15) / 20)
            if level.keys:
                for key in level.keys:
                    offset = (key.ticks // NATIVE_FACTOR) - clip['in']
                    fade_in, fade_out = clip.get('fadeIn', 0), clip.get('fadeOut', 0)
                    wanted = amplitude * min(1, offset / fade_in if fade_in else 1) * min(1, (clip['duration'] - offset) / fade_out if fade_out else 1)
                    if abs(level.get_value_at_key(key) - wanted) > 0.000002: raise ValueError('Native audio envelope did not round-trip.')
            elif abs(level.value - amplitude) > 0.000002: raise ValueError('Native gain did not round-trip.')
    print(json.dumps({'type': 'result', 'verified': True, 'warnings': sorted(set(warnings))}), flush=True)

if __name__ == '__main__':
    try:
        payload, target = Path(sys.argv[1]), Path(sys.argv[2])
        build(json.loads(payload.read_text(encoding='utf-8')), target, payload.parent)
    except Exception as error:
        sys.stderr.write(str(error) + '\n'); sys.exit(1)
