"""Create an isolated Python runtime and launch FieldLink on Windows/macOS/Linux."""

from pathlib import Path
import subprocess
import sys
import venv


def main():
    if sys.version_info < (3, 11):
        print("Python 3.11 or newer is required.", file=sys.stderr)
        return 1
    root = Path(__file__).resolve().parent
    python = root / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not python.is_file():
        print("Creating the project's Python virtual environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(root / ".venv")
    check = subprocess.run(
        [str(python), "-c", "from importlib.metadata import version; assert version('aiohttp') == '3.14.5'"],
        cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if check.returncode:
        print("Installing Python aiohttp dependencies...", flush=True)
        installed = subprocess.run([str(python), "-m", "pip", "install", "-r", str(root / "requirements.txt")], cwd=root)
        if installed.returncode:
            print("Dependency installation failed. Check the internet connection.", file=sys.stderr)
            return installed.returncode
    try:
        return subprocess.call([str(python), str(root / "server.py"), *sys.argv[1:]], cwd=root)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
