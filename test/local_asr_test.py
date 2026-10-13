"""No MLX imports, model downloads, network, or private audio."""
import array
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
import wave

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "local-asr.py"
MODULE = runpy.run_path(str(SCRIPT))


class LocalASRTests(unittest.TestCase):
    def test_pause_partition_keeps_every_sample(self):
        pcm = array.array("h", [2000] * 48000 + [0] * 16000 + [2000] * 64000).tobytes()
        windows = MODULE["pause_windows"](pcm)
        self.assertEqual(windows, [(0, 56000), (56000, 128000)])
        self.assertEqual(b"".join(pcm[a * 2:b * 2] for a, b in windows), pcm)

    def test_brief_pause_does_not_fragment_speech(self):
        pcm = array.array("h", [2000] * 48000 + [0] * 3200 + [2000] * 64000).tobytes()
        self.assertEqual(MODULE["pause_windows"](pcm), [(0, 115200)])

    def test_subchunks_preserve_sample_bytes_and_absolute_pts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            pcm = array.array("h", [2000] * 48000 + [0] * 16000 + [2000] * 64000).tobytes()
            with wave.open(str(root / "audio.wav"), "wb") as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000); output.writeframes(pcm)
            request = {"audio": [{"path": "audio.wav", "source": "system", "startMs": 12000, "endMs": 20000}]}
            parts = list(MODULE["audio_items"](request, root, "local-qwen"))
            self.assertEqual([(item[1]["startMs"], item[1]["endMs"]) for item in parts], [(12000, 15500), (15500, 20000)])
            self.assertEqual(b"".join(item[3] for item in parts), pcm)
            self.assertEqual(parts[1][1]["parentStartFrame"], 56000)
            for _, chunk, file, _ in parts:
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(chunk["parentAudioPath"], "audio.wav")

    def test_timeline_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with wave.open(str(root / "audio.wav"), "wb") as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000); output.writeframes(b"\0" * 32000)
            request = {"audio": [{"path": "audio.wav", "source": "system", "startMs": 0, "endMs": 2000}]}
            with self.assertRaisesRegex(ValueError, "timeline"):
                list(MODULE["audio_items"](request, root, "local-qwen"))

    def test_supervisor_stops_itself_and_child_when_parent_dies(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid_file = str(Path(directory) / "child.pid")
            child_code = "import os,time,pathlib;pathlib.Path(%r).write_text(str(os.getpid()));time.sleep(30)" % child_pid_file
            arguments = [sys.executable, str(SCRIPT), "supervise", "--exec", sys.executable, "-c", child_code]
            launcher = """
import os,subprocess,time,pathlib,json
env=dict(os.environ,MEETING_ANALYSIS_PARENT_PID=str(os.getpid()))
child=subprocess.Popen(%r,env=env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(50):
 if pathlib.Path(%r).exists():break
 time.sleep(.05)
print(child.pid,flush=True)
os._exit(0)
""" % (arguments, child_pid_file)
            result = subprocess.run([sys.executable, "-c", launcher], text=True, capture_output=True, timeout=5, check=True)
            supervisor = int(result.stdout.strip()); descendant = int(Path(child_pid_file).read_text())
            def live(pid):
                try:
                    os.kill(pid, 0)
                    return True
                except ProcessLookupError:
                    return False
            try:
                for _ in range(40):
                    if not live(supervisor) and not live(descendant):
                        break
                    time.sleep(.1)
                self.assertFalse(live(supervisor), "Supervisor continued after Node-equivalent parent died")
                self.assertFalse(live(descendant), "Setup descendant outlived its supervisor")
            finally:
                try:
                    os.killpg(supervisor, 9)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
