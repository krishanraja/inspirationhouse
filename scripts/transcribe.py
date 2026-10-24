#!/usr/bin/env python3
"""Speech to text for one saved video, on the runner. Prints JSON {"text": ...} or {"text": null}.

The same model family content-engine's style study uses (scripts/quick-edit/references.py, faster-whisper). It runs
on CPU and never calls out. Nothing it hears is logged: the words go back to the tagger on stdout only.
"""
import json
import os
import sys


def main(path: str) -> None:
    try:
        from faster_whisper import WhisperModel
    except Exception:  # noqa: BLE001 no model here: the tagger watches frames only
        print(json.dumps({"text": None}))
        return
    model = WhisperModel(os.environ.get('TASTE_WHISPER_MODEL', 'base'), device='cpu', compute_type='int8')
    segments, _ = model.transcribe(path, vad_filter=True)
    text = ' '.join(s.text.strip() for s in segments).strip()
    print(json.dumps({"text": text[:20000] or None}))


if __name__ == '__main__':
    main(sys.argv[1])
