"""Create and check a Resolve 21 project from a compiled CUT timeline."""
import json
import math
import struct
import sys
import zipfile
from fractions import Fraction
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
from pr2_native import export_native_drp, _parse_native_xml

TICKS = 35_280_000


def field(parent, tag, value):
    ET.SubElement(parent, tag).text = str(value)


def set_rate(parent, fps):
    rate = ET.SubElement(parent, "rate")
    field(rate, "timebase", float(fps))
    field(rate, "ntsc", "FALSE")


def sequence_for(film):
    fps = Fraction(film["fps"]["num"], film["fps"]["den"])
    def frame(ticks):
        return int(ticks * fps / TICKS + Fraction(1, 2))

    seq = ET.Element("sequence")
    field(seq, "name", film["name"])
    field(seq, "duration", math.ceil(film["duration"] * fps / TICKS))
    set_rate(seq, fps)
    media = ET.SubElement(seq, "media")
    branches = {kind: ET.SubElement(media, kind) for kind in ("video", "audio")}
    fmt = ET.SubElement(ET.SubElement(branches["video"], "format"), "samplecharacteristics")
    for dim in ("width", "height"):
        field(fmt, dim, film["resolution"][dim])
    expected = []
    file_id = 0
    for track in film["tracks"]:
        kind = track["kind"]
        lane = ET.SubElement(branches[kind], "track")
        field(lane, "name", track["name"])
        checks = []
        for c in sorted(track["clips"], key=lambda item: item["at"]):
            item = ET.SubElement(lane, "clipitem")
            name = c.get("name") or Path(c["path"]).name
            info = c["media"]
            if kind == "audio" and info.get("channels", 1) > 1:
                lane.set("cut-stereo", "1")
                item.set("cut-stereo", "1")
            start, end = frame(c["at"]), frame(c["end"])
            if end <= start:
                raise ValueError(f"{name} is shorter than one Resolve timeline frame")
            for tag, val in (("name", name), ("start", start), ("end", end), ("in", c["in"]), ("out", c["out"])):
                field(item, tag, val)
            # The native writer converts source timing into Resolve record frames.
            set_rate(item, TICKS)
            file_id += 1
            file = ET.SubElement(item, "file", id=f"file-{file_id}")
            full_path = Path(c["absolutePath"])
            field(file, "name", full_path.name)
            field(file, "pathurl", full_path.as_uri())
            rate = info.get("fps") if info.get("hasVideo") else None
            source_fps = Fraction(rate["num"], rate["den"]) if rate else fps
            set_rate(file, source_fps)
            field(file, "duration", math.ceil(info["duration"] * source_fps / TICKS))
            streams = ET.SubElement(file, "media")
            if info["hasVideo"]:
                video = ET.SubElement(ET.SubElement(streams, "video"), "samplecharacteristics")
                for dim in ("width", "height"):
                    field(video, dim, info[dim])
            if info["hasAudio"]:
                audio = ET.SubElement(streams, "audio")
                field(audio, "channelcount", info.get("channels", 1))
                field(ET.SubElement(audio, "samplecharacteristics"), "samplerate", info.get("sampleRate", 48000))
            checks.append((name, start, end-start, float(c["in"] * fps / TICKS), str(full_path)))
        expected.append((kind, track["name"], checks))
    return seq, expected


def verify(output, expected, film):
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError("Resolve project archive failed its checksum")
        seq, = [n for n in archive.namelist() if n.startswith("SeqContainer/") and n.endswith(".xml")]
        native = _parse_native_xml(archive.read(seq))
        pool = _parse_native_xml(archive.read("MediaPool/Master/MpFolder.xml"))
        media_ids = {n.get("DbId") for n in pool.iter() if n.tag in ("Sm2MpVideoClip", "Sm2MpAudioClip")}
        sequence, = pool.iter("Sm2Sequence")
        geometry = struct.unpack(">QQ", bytes.fromhex(sequence.findtext("Resolution")))
        rate, = struct.unpack("<d", bytes.fromhex(sequence.findtext("FrameRate"))[:8])
        begin, end = struct.unpack("<dd", bytes.fromhex(sequence.findtext("MediaExtents")))
        fps = Fraction(film["fps"]["num"], film["fps"]["den"])
        duration = math.ceil(film["duration"] * fps / TICKS)
        if (geometry != (film["resolution"]["width"], film["resolution"]["height"])
            or not math.isclose(rate, float(fps)) or begin != 0 or abs(end * rate - duration) > 1e-6):
            raise ValueError("Resolve sequence dimensions, frame rate or duration mismatch")
        for kind in ("video", "audio"):
            tracks = native.findall(f".//{kind.title()}TrackVec/Element/Sm2TiTrack")
            wanted = [t for t in expected if t[0] == kind]
            for track, (_, name, items) in zip(tracks, wanted, strict=True):
                if track.findtext("UserDefinedName") != name:
                    raise ValueError(f"Resolve track name mismatch on {name}")
                clips = track.findall(f"Items/Element/Sm2Ti{kind.title()}Clip")
                for clip, (label, start, length, source_in, path) in zip(clips, items, strict=True):
                    whole, _, fraction = clip.findtext("In").partition("|")
                    actual_in = int(whole) + (struct.unpack("<d", bytes.fromhex(fraction))[0] if fraction else 0)
                    if (clip.findtext("Name") != label or int(clip.findtext("Start")) != start
                        or int(clip.findtext("Duration")) != length or abs(actual_in-source_in) > 1e-6
                        or clip.findtext("MediaFilePath") != path or clip.findtext("MediaRef") not in media_ids):
                        raise ValueError(f"Resolve media or timing mismatch for {label}")


if __name__ == "__main__":
    film = json.loads(Path(sys.argv[1]).read_text())
    sequence, expected = sequence_for(film)
    export_native_drp(sequence, sys.argv[2], film["name"])
    verify(sys.argv[2], expected, film)
