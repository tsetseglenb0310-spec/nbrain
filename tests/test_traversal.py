"""Проверка обхода каталога БЕЗ авторизации на исходном коде проекта.

Тест работает на КОПИИ проекта во временном каталоге. Раньше он подключался к
настоящему `data/` и писал туда заметку-маркер `m1` — то есть модифицировал
рабочую базу пользователя и мог затереть существующую запись. Копия даёт тот же
результат: маркер и файлы, которые пробы пытаются вытащить, лежат в копии.
"""
import http.client, os, shutil, sys, tempfile, threading, time
from pathlib import Path

TARGET = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent)
WORK = Path(tempfile.mkdtemp(prefix="nbtrav-"))

# Копируем ровно то, что нужно серверу и пробам: код, статику и requirements.
# .env и data/ из проекта не копируются — секреты и рабочая база не участвуют.
source = Path(TARGET)
shutil.copy2(source / "server.py", WORK / "server.py")
shutil.copy2(source / "requirements.txt", WORK / "requirements.txt")
shutil.copytree(source / "web", WORK / "web")
(WORK / "data").mkdir(exist_ok=True)

os.environ.update({
    "NBRAIN_DATA_DIR": str(WORK / "data"),
    "OPENAI_API_KEY": "test-key",
    "NBRAIN_AUTH_REQUIRED": "1",
    "NBRAIN_ADMIN_PASSWORD": "Пароль-2026",
    "NBRAIN_SESSION_SECRET": "z" * 48,
})
sys.path.insert(0, str(WORK))
import server

assert Path(server.__file__).resolve().parent == WORK.resolve(), (
    f"Тест должен работать на копии в {WORK}, а импортировался {server.__file__}"
)
assert server.DATA_DIR.resolve() == (WORK / "data").resolve(), (
    f"NBRAIN_DATA_DIR указывает на {server.DATA_DIR}, а не на копию"
)

server.init_storage()
# Кладём заметный маркер в базу КОПИИ, чтобы увидеть утечку данных.
server.save_memory(server.primary_user()["id"], {"kind": "note", "content": "СЕКРЕТНАЯ-ЗАМЕТКА-ДИРЕКТОРА"})

httpd = server.ThreadingHTTPServer(("127.0.0.1", 8942), server.AppHandler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.3)


def get(path):
    """Запрос БЕЗ cookie — как от анонимного посетителя из интернета."""
    conn = http.client.HTTPConnection("127.0.0.1", 8942, timeout=10)
    conn.putrequest("GET", path, skip_host=False, skip_accept_encoding=True)
    conn.putheader("Host", "127.0.0.1")
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, body


print(f"\nПроверяем копию {TARGET} в {WORK} — все запросы БЕЗ авторизации:\n")
probes = [
    ("/web/../server.py", b"OPENAI_API_KEY"),
    ("/web/../data/nbrain.db", b"\xd0\xa1\xd0\x95\xd0\x9a\xd0\xa0\xd0\x95\xd0\xa2"),
    ("/web/../../etc/passwd", b"root:"),
    ("/web/%2e%2e/server.py", b"ADMIN_PASSWORD"),
    ("/web/../requirements.txt", b"pypdf"),
]
leaked = 0
for path, marker in probes:
    status, body = get(path)
    hit = status == 200 and marker in body
    if hit:
        leaked += 1
    label = "ПРОТЕКАЕТ" if hit else "закрыто"
    print(f"  [{label:>9}]  {path:<32} -> HTTP {status}, {len(body)} байт")

status, body = get("/web/styles.css")
print(f"\n  Обычная статика /web/styles.css -> HTTP {status} ({len(body)} байт) — должна работать")
status, body = get("/")
print(f"  Главная страница /            -> HTTP {status} ({len(body)} байт) — должна работать")

httpd.shutdown()
shutil.rmtree(WORK, ignore_errors=True)
print(f"\nУтечек: {leaked} из {len(probes)}")
sys.exit(1 if leaked else 0)
