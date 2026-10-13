#!/usr/bin/env python3
"""One offline MLX model load per analysis run; no credentials or tools.

Download is an explicit, separate install command. Inference is additionally
launched by Node in a macOS deny-network sandbox. Chunk boundaries are evidence
windows, never claimed to be word alignment or speaker diarization.
"""
import argparse
import dataclasses
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import time
import wave
import uuid
import signal
import threading
import subprocess
from array import array

MODELS = {
    "local-qwen": {"repo": "mlx-community/Qwen3-ASR-1.7B-4bit", "revision": "78a389c776a5483b2d0d4ea5494e11012e0d6159", "directory": "Qwen3-ASR-1.7B-4bit"},
    "local-mimo": {"repo": "mlx-community/MiMo-V2.5-ASR-MLX", "revision": "69813f0d57fb9bb5328735c4e907a4558b47d341", "directory": "MiMo-V2.5-ASR-MLX"},
}
TOKENIZER = {"repo": "mlx-community/MiMo-Audio-Tokenizer", "revision": "6d451ed9a73024b4d33b87afa69e0dfd40d8f306", "directory": "MiMo-Audio-Tokenizer"}


def watch_parent():
    value = os.environ.get("MEETING_ANALYSIS_PARENT_PID", "")
    if not value.isdigit() or int(value) <= 1:
        return
    parent = int(value)
    def check():
        while True:
            if os.getppid() != parent:
                if os.getpgrp() == os.getpid():
                    os.killpg(os.getpgrp(), signal.SIGTERM)
                os._exit(125)
            time.sleep(0.5)
    threading.Thread(target=check, daemon=True, name="meeting-analysis-parent").start()


def save(path, value):
    temporary = path.with_name(path.name + ".partial")
    with open(temporary, "w", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def scoped(path, root):
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ValueError("ASR audio must be a regular file inside this analysis run")
    return candidate


def pause_windows(pcm, sample_rate=16000):
    """Partition on sustained quiet; do not remove, duplicate, or reorder samples.

    Qwen's language detector can select the final language of a long mixed clip.
    Re-evaluating language across real pauses avoids retaining that language for
    the whole clip. This is not diarization or proof of a language boundary.
    """
    samples = array("h"); samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    window = sample_rate // 50  # 20 ms
    quiet_start, quiet_ranges = None, []
    for offset in range(0, len(samples), window):
        values = samples[offset:offset + window]
        quiet = bool(values) and sum(value * value for value in values) / len(values) < 250**2
        if quiet and quiet_start is None:
            quiet_start = offset
        elif not quiet and quiet_start is not None:
            if offset - quiet_start >= sample_rate * 0.4:
                quiet_ranges.append((quiet_start, offset))
            quiet_start = None
    if quiet_start is not None and len(samples) - quiet_start >= sample_rate * 0.4:
        quiet_ranges.append((quiet_start, len(samples)))
    cuts = [0]
    for start, end in quiet_ranges:
        middle = (start + end) // 2
        if middle - cuts[-1] >= sample_rate * 2.5 and len(samples) - middle >= sample_rate:
            cuts.append(middle)
    cuts.append(len(samples))
    return list(zip(cuts, cuts[1:]))


def audio_items(request, root, provider):
    attempt = request.get("attemptID") or uuid.uuid4().hex
    if not isinstance(attempt, str) or len(attempt) > 64 or not all(c in "0123456789abcdef-" for c in attempt):
        raise ValueError("Invalid ASR attempt identifier")
    for chunk_index, chunk in enumerate(request["audio"]):
        file = scoped(chunk["path"], root)
        start, end = float(chunk["startMs"]), float(chunk["endMs"])
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= 86400100:
            raise ValueError("Invalid ASR timeline")
        with wave.open(str(file), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or wav.getnframes() > 31 * 16000:
                raise ValueError("Expected a bounded 16 kHz mono PCM chunk")
            frames = wav.getnframes(); pcm = wav.readframes(frames)
        if abs((end - start) - frames / 16) > 1:
            raise ValueError("ASR chunk length does not match its session timeline")
        windows = pause_windows(pcm) if provider == "local-qwen" else [(0, frames)]
        if len(windows) == 1:
            yield chunk_index, chunk, file, pcm
            continue
        parent = root / "asr-subchunks"
        parent.mkdir(mode=0o700, exist_ok=True)
        if parent.resolve() != parent:
            raise ValueError("ASR subchunks cannot leave this analysis folder")
        folder = parent / attempt
        folder.mkdir(mode=0o700, exist_ok=True)
        if folder.resolve() != folder:
            raise ValueError("ASR subchunks cannot leave this analysis folder")
        for sub_index, (begin, finish) in enumerate(windows):
            name = "asr-subchunks/%s/qwen-%06d-%04d.wav" % (attempt, chunk_index, sub_index)
            target = root / name
            if target.exists() or target.is_symlink():
                raise ValueError("ASR subchunk already exists; retry in a new analysis run")
            with wave.open(str(target), "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(pcm[begin * 2:finish * 2])
            target.chmod(0o600)
            part = dict(chunk, path=name, startMs=start + begin / 16, endMs=start + finish / 16,
                        parentAudioPath=chunk["path"], parentStartFrame=begin, frames=finish - begin)
            yield chunk_index, part, target, pcm[begin * 2:finish * 2]


def fix_mimo_prompt():
    # The pinned port used malformed literal thinking/response text and a forced
    # Chinese tag. Build the official <think> suffix with the actual tokenizer.
    # Reference: XiaomiMiMo/MiMo-V2.5-ASR get_asr_sft_prompt.
    import mlx.core as mx
    from mlx_audio.stt.models.mimo_v2_asr import asr
    from mlx_audio.stt.models.mimo_v2_asr.prompt import InputSegment

    def prompt(audio_codes, text_token_ids, config, tokenizer=None, language="auto"):
        shared = dict(speech_empty_ids=config.parsed_speech_empty_ids(), text_empty_id=config.empty_idx,
                      sosp_id=config.sosp_idx, eosp_id=config.eosp_idx, group_size=config.group_size,
                      audio_channels=config.audio_channels)
        def text(value):
            return InputSegment(text_token_ids=mx.array(tokenizer.encode(value), dtype=mx.int32), **shared).build()
        language_tag = {"zh": "<chinese>", "en": "<english>"}.get(language, "")
        instruction = "将音频内容转换成文字格式" if language == "zh" else "Please transcribe this audio file"
        return mx.concatenate([text("<|im_start|>user\n"), InputSegment(audio_codes=audio_codes, **shared).build(),
                               text(instruction), text("<|im_end|>\n"), text("<|im_start|>assistant\n"),
                               text("<think>\n\n</think>\n" + language_tag)], axis=1)
    asr.build_asr_prompt = prompt


def install(root, provider):
    from huggingface_hub import snapshot_download
    spec = MODELS[provider]
    for entry in ([TOKENIZER, spec] if provider == "local-mimo" else [spec]):
        target = root / "models" / entry["directory"]
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        snapshot_download(entry["repo"], revision=entry["revision"], local_dir=str(target),
                          allow_patterns=["*.json", "*.safetensors", "*.model", "*.tiktoken", "*.txt", "*.jinja", "LICENSE*", "README.md"],
                          token=False)
        save(target / "meeting-archive-model.json", entry)
    print(json.dumps({"installed": provider, "model": spec, "runtime": importlib.metadata.version("mlx-audio")}))


def infer(request_file):
    request = json.loads(request_file.read_text())
    root = Path(request["runDirectory"]).resolve()
    provider = request["provider"]
    if provider not in MODELS or len(request["audio"]) > 20000:
        raise ValueError("Invalid offline ASR request")
    model_path = Path(request["modelPath"]).resolve()
    if not model_path.is_dir():
        raise ValueError("Install the selected local ASR model before analysis")
    import mlx.core as mx
    from mlx_audio.stt.utils import load
    mx.set_memory_limit(16 * 1024**3)
    mx.set_cache_limit(256 * 1024**2)
    if provider == "local-mimo":
        fix_mimo_prompt()
    model = load(str(model_path))
    segments, raw, uncertainties = [], [], ["Speaker diarization has not been run; audio source is not a person's identity.",
        "Local MLX timestamps are audio chunk boundaries (up to 30 seconds), not word or sentence alignment.",
        "Speech at a chunk boundary may be incomplete; verify against the original recording."]
    if provider == "local-mimo":
        uncertainties.append("MiMo uses the corrected official prompt suffix; meeting-quality validation remains limited.")
    else:
        uncertainties.append("Qwen re-detects language at sustained pauses; natural within-sentence language switching still needs review.")
    for index, (base_index, chunk, file, pcm) in enumerate(audio_items(request, root, provider)):
        start, end = float(chunk["startMs"]), float(chunk["endMs"])
        if not any(pcm):
            raw.append({"chunk": chunk["path"], "exactDigitalSilence": True})
            continue
        started = time.monotonic()
        # Passing the FILE lets MiMo's loader resample correctly to its 24 kHz
        # encoder; passing a 16 kHz ndarray would silently be misinterpreted.
        output = model.generate(str(file), language=None, max_tokens=2048, temperature=0, verbose=False)
        mx.synchronize()
        result = dataclasses.asdict(output) if dataclasses.is_dataclass(output) else {"text": str(output.text)}
        raw.append({"chunk": chunk["path"], "parentAudioPath": chunk.get("parentAudioPath"), "parentStartFrame": chunk.get("parentStartFrame"),
                    "startMs": start, "endMs": end, "elapsedSeconds": time.monotonic() - started, "output": result})
        text = str(result.get("text", "")).strip()
        language = result.get("language")
        if isinstance(language, list):
            language = ", ".join(dict.fromkeys(str(item) for item in language if item)) or None
        if text:
            segments.append({"id": "asr_%06d" % index, "source": chunk["source"], "startMs": start, "endMs": end, "text": text,
                             "language": language, "model": request["model"], "modelRevision": request.get("revision"),
                             "speaker": None, "timing": "chunk-boundary", "audioPath": chunk["path"]})
        if result.get("generation_tokens", 0) >= 2048:
            uncertainties.append("ASR reached its token limit for %s; transcription may be truncated." % chunk["path"])
        save(root / "asr-progress.json", {"currentAudioChunk": base_index + 1, "totalAudioChunks": len(request["audio"]), "completedWindows": index + 1, "segments": segments})
        mx.clear_cache()
    save(root / "asr-raw.json", {"model": request["model"], "revision": request.get("revision"), "provider": provider, "chunks": raw,
                                "runtime": {p: importlib.metadata.version(p) for p in ["mlx", "mlx-audio", "mlx-lm", "transformers"]}})
    save(root / "local-transcript.json", {"segments": segments, "uncertainties": uncertainties, "model": request["model"], "revision": request.get("revision")})
    print(json.dumps({"ok": True, "segments": len(segments)}))


if __name__ == "__main__":
    watch_parent()
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["install", "infer", "supervise"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--provider", choices=list(MODELS))
    parser.add_argument("--request", type=Path)
    parser.add_argument("--exec", dest="exec_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.command == "supervise":
            if not args.exec_args:
                parser.error("supervise requires --exec and its command arguments")
            # The caller supplies fixed interpreter/pip arguments. Keep children
            # in our own process group so the parent watchdog also stops setup.
            sys.exit(subprocess.call(args.exec_args))
        elif args.command == "install":
            if args.root is None or args.provider is None:
                parser.error("install requires --root and --provider")
            install(args.root, args.provider)
        else:
            if args.request is None:
                parser.error("infer requires --request")
            infer(args.request)
    except Exception as error:
        print(type(error).__name__ + ": " + str(error)[:2000], file=sys.stderr)
        sys.exit(1)
