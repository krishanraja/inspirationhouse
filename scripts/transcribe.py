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
"""
import json
import os
import subprocess
import sys

SAMPLE_RATE = 16000


def say(text, heard, failure=None):
    print(json.dumps({"text": text, "heard": heard, "failure": failure}))


def main(path):
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except Exception:  # noqa: BLE001 no model here: the tagger watches frames only
        say(None, 'failed', 'no_model')
        return
    try:
        streams = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path],
            check=True, capture_output=True, timeout=30,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        say(None, 'failed', 'decode')
        return
    if not streams:
        say(None, 'silent')  # no sound track at all
        return
    try:
        pcm = subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'f32le', '-'],
            check=True, capture_output=True, timeout=300,
        ).stdout
        audio = np.frombuffer(pcm, dtype=np.float32)
    except Exception:  # noqa: BLE001
        say(None, 'failed', 'decode')
        return
    if audio.size < SAMPLE_RATE // 2:
        say(None, 'silent')  # no audio track, or under half a second of it
        return
    try:
        model = WhisperModel(os.environ.get('TASTE_WHISPER_MODEL', 'base'), device='cpu', compute_type='int8')
        segments, _ = model.transcribe(audio, vad_filter=True)
        text = ' '.join(s.text.strip() for s in segments).strip()[:20000]
    except Exception:  # noqa: BLE001
        say(None, 'failed', 'transcribe')
        return
    say(text or None, 'words' if text else 'silent')


if __name__ == '__main__':
    main(sys.argv[1])
