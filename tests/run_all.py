"""Запуск всех тестов NBrain одной командой: `python tests/run_all.py`.

Тесты написаны как самостоятельные скрипты с собственным счётчиком проверок,
а не как классы unittest, поэтому `python -m unittest discover` их не находит.
Каждый скрипт запускается отдельным процессом (у каждого своя временная база
и свой порт), вывод идёт в UTF-8, код выхода — 1, если хоть один провалился.
"""
import os
import subprocess
import sys
from pathlib import Path

TESTS = ["test_nbrain.py", "test_http.py", "test_traversal.py"]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    here = Path(__file__).resolve().parent
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    failed = []
    for name in TESTS:
        print(f"\n######## {name} ########", flush=True)
        code = subprocess.call([sys.executable, str(here / name)], cwd=str(here.parent), env=env)
        if code != 0:
            failed.append(name)
    print("\n" + "=" * 54)
    if failed:
        print("ПРОВАЛЕНО:", ", ".join(failed))
        return 1
    print(f"Все {len(TESTS)} набора тестов пройдены.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
