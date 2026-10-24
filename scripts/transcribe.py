#!/usr/bin/env python3
"""Speech to text for one saved video, on the runner.

Prints one JSON line: {"text": ..., "heard": "words" | "silent" | "failed", "failure": <class> | null}.
`failure` is a class only (no_model, decode, transcribe), never a message, because the run's log is public.

The same model family content-engine's style study uses (scripts/quick-edit/references.py, faster-whisper). It runs
on CPU and never calls out once the model is cached. Nothing it hears is logged: the words go back to the tagger on
stdout only.

The audio is decoded by ffmpeg, which the runner already has for the frames, and handed to the model as samples.
faster-whisper's own decoder (PyAV) broke twice on a clean install (2026-10-24): 1.1.1 imports `requests` without
declaring it, and every faster-whisper release calls av.open(metadata_errors=...), which current PyAV refuses.
Either one quietly turned every video into "no words".

Every sound track is heard, in order, and their words joined: ffmpeg on its own takes only the one it picks, so the
words on a second track (a voice-over beside the music, a second language) were never heard. A track that cannot be
decoded, or that the model fails on, is skipped while another has words; only when none has words is the failure said,
the model's before the decoder's.
"""
import json
import os
import subprocess
import sys

SAMPLE_RATE = 16000


def say(text, heard, failure=None):
    print(json.dumps({"text": text, "heard": heard, "failure": failure}))


def audio_streams(path):
    """The index of every sound track in the file, in order."""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path],
        check=True, capture_output=True, timeout=30,
    ).stdout.decode('ascii', 'ignore')
    return [int(line.split(',')[0]) for line in out.split() if line.split(',')[0].isdigit()]


def decode(np, path, index):
    """One sound track as 16 kHz mono samples."""
    pcm = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-map', '0:%d' % index, '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE),
         '-f', 'f32le', '-'],
        check=True, capture_output=True, timeout=300,
    ).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def main(path):
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except Exception:  # noqa: BLE001 no model here: the tagger watches frames only
        say(None, 'failed', 'no_model')
        return
    try:
        streams = audio_streams(path)
    except Exception:  # noqa: BLE001
        say(None, 'failed', 'decode')
        return
    if not streams:
        say(None, 'silent')  # no sound track at all
        return
    model = None
    texts = []
    undecoded = 0
    unheard = 0
    for index in streams:
        try:
            audio = decode(np, path, index)
        except Exception:  # noqa: BLE001
            undecoded += 1
            continue
        if audio.size < SAMPLE_RATE // 2:
            continue  # under half a second of sound on this track
        try:
            if model is None:
                model = WhisperModel(os.environ.get('TASTE_WHISPER_MODEL', 'base'), device='cpu', compute_type='int8')
            segments, _ = model.transcribe(audio, vad_filter=True)
            text = ' '.join(s.text.strip() for s in segments).strip()
        except Exception:  # noqa: BLE001
            unheard += 1
            continue
        if text:
            texts.append(text)
    words = ' '.join(texts).strip()[:20000]
    if words:
        say(words, 'words')
    elif unheard:
        say(None, 'failed', 'transcribe')
    elif undecoded:
        say(None, 'failed', 'decode')
    else:
        say(None, 'silent')


if __name__ == '__main__':
    main(sys.argv[1])
