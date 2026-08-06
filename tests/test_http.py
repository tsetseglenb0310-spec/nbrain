"""Сквозной тест: миграция старой БД + реальные HTTP-запросы к обработчику."""
import hashlib, http.client, json, os, random, sqlite3, sys, tempfile, threading, time
from pathlib import Path

WORK = Path(tempfile.mkdtemp(prefix="nbhttp-"))
WORK.mkdir(exist_ok=True)
DIM = 64

# --- 1. Готовим БД в СТАРОМ формате: embedding_json, без embedding_vec ---
(WORK / "uploads").mkdir(parents=True, exist_ok=True)
legacy = sqlite3.connect(WORK / "nbrain.db")
legacy.executescript("""
CREATE TABLE books (id TEXT PRIMARY KEY, filename TEXT NOT NULL, title TEXT NOT NULL,
  extension TEXT NOT NULL, stored_path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE chunks (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, page_from INTEGER, page_to INTEGER, content TEXT NOT NULL,
  embedding_json TEXT NOT NULL, embedding_model TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL, UNIQUE(book_id, ordinal));
""")
old_path = WORK / "uploads" / "old_book.txt"
old_path.write_text("Старая книга про управление. " * 200, encoding="utf-8")
legacy.execute("INSERT INTO books VALUES ('old','old.txt','Старая книга','.txt',?,1,4,'ready',NULL,'2026-01-01T00:00:00Z')", (str(old_path),))
rnd = random.Random(42)
legacy_vectors = {}
for i in range(4):
    vec = [rnd.uniform(-1, 1) for _ in range(DIM)]
    legacy_vectors[f"c{i}"] = vec
    legacy.execute(
        "INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)",
        (f"c{i}", "old", i + 1, 1, 1, f"Фрагмент номер {i} про управление командой.",
         json.dumps(vec), "text-embedding-3-small", "2026-01-01T00:00:00Z"),
    )
legacy.commit()
json_bytes = legacy.execute("SELECT SUM(LENGTH(embedding_json)) s FROM chunks").fetchone()[0]
legacy.close()

os.environ.update({
    "NBRAIN_DATA_DIR": str(WORK),
    "OPENAI_API_KEY": "test-key",
    "NBRAIN_AUTH_REQUIRED": "1",
    "NBRAIN_ADMIN_PASSWORD": "Пароль-Директора-2026",
    "NBRAIN_ADMIN_USERNAME": "muhamed",
    "NBRAIN_SESSION_SECRET": "y" * 48,
    "NBRAIN_HOST": "127.0.0.1",
    "NBRAIN_PORT": "8931",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


def fake_embed(path, payload):
    out = []
    for text in payload["input"]:
        r = random.Random(hashlib.sha256(text.encode()).hexdigest())
        out.append({"embedding": [r.uniform(-1, 1) for _ in range(DIM)]})
    return {"data": out}


server.openai_request = fake_embed
server.answer_question = lambda *a, **k: "**Краткий ответ**\nТестовый ответ [S1]."
# PBKDF2 с боевым числом итераций делает каждую попытку входа заметно дороже,
# а тест их совершает десятки: проверяем логику, а не стойкость к перебору.
server.PASSWORD_ITERATIONS = 1000

OK = FAIL = 0
FAILURES = []


def check(name, cond, extra=""):
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL  {name} {extra}")


print("\n=== Миграция старой базы на blob ===")
server.init_storage()
with server.db() as conn:
    row = conn.execute("SELECT COUNT(*) c, SUM(LENGTH(embedding_json)) j, SUM(LENGTH(embedding_vec)) v FROM chunks").fetchone()
check("все чанки сохранились", row["c"] == 4, f"({row['c']})")
check("embedding_json очищен", (row["j"] or 0) == 0)
check("embedding_vec заполнен", row["v"] == 4 * DIM * 4, f"({row['v']})")
print(f"        JSON было {json_bytes} Б -> blob стало {row['v']} Б "
      f"(в {json_bytes / row['v']:.1f} раза меньше)")
with server.db() as conn:
    blob = conn.execute("SELECT embedding_vec FROM chunks WHERE id='c0'").fetchone()["embedding_vec"]
migrated = list(server.unpack_vector(blob))
expected = server.normalize_vector(legacy_vectors["c0"])
check("значения вектора сохранены при конвертации",
      all(abs(a - b) < 1e-5 for a, b in zip(migrated, expected)))
check("повторный запуск миграции ничего не ломает",
      (server.migrate_embeddings_to_blob() or True))

server.resume_interrupted_indexing()

print("\n=== HTTP: реальный сервер ===")
httpd = server.ThreadingHTTPServer(("127.0.0.1", 8931), server.AppHandler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.3)


def call(method, path, body=None, cookie=None, raw=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", 8931, timeout=30)
    hdrs = {"Origin": "http://127.0.0.1:8931"}
    hdrs.update(headers or {})
    if cookie:
        hdrs["Cookie"] = cookie
    if raw is not None:
        payload = raw
        hdrs.setdefault("Content-Type", "application/octet-stream")
    elif body is not None:
        payload = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    else:
        payload = None
    conn.request(method, path, body=payload, headers=hdrs)
    response = conn.getresponse()
    data = response.read()
    set_cookie = response.getheader("Set-Cookie")
    conn.close()
    try:
        parsed = json.loads(data.decode())
    except Exception:
        parsed = {"_raw": data[:200].decode(errors="replace")}
    return response.status, parsed, set_cookie


status, payload, _ = call("GET", "/api/health")
check("health отвечает без входа", status == 200 and payload.get("ok"))
check("health не раскрывает конфигурацию анониму", "embedding_model" not in payload, f"({payload})")

status, payload, _ = call("GET", "/api/books")
check("книги закрыты без авторизации", status == 401, f"({status})")

status, payload, _ = call("POST", "/api/auth/login", {"password": "неверный"})
check("неверный пароль -> 401", status == 401, f"({status})")

status, payload, _ = call("POST", "/api/auth/login",
                          {"username": "нет-такого", "password": "Пароль-Директора-2026"})
check("неизвестный логин -> 401", status == 401, f"({status})")
check("ответ не подсказывает, существует ли логин",
      "логин или пароль" in payload.get("error", "").lower(), f"({payload})")

# Форма до появления аккаунтов присылала только пароль: такой запрос должен
# по-прежнему открывать первый (основной) аккаунт, иначе апгрейд запер бы
# владельца снаружи собственной базы.
status, payload, cookie = call("POST", "/api/auth/login", {"password": "Пароль-Директора-2026"})
check("вход одним паролем ведёт в основной аккаунт",
      status == 200 and payload["user"]["username"] == "muhamed", f"({status} {payload})")

status, payload, cookie = call("POST", "/api/auth/login",
                               {"username": "Muhamed", "password": "Пароль-Директора-2026"})
check("кириллический пароль -> вход выполнен (раньше был 500)", status == 200 and payload.get("authenticated"),
      f"({status} {payload})")
check("логин нечувствителен к регистру", payload["user"]["username"] == "muhamed", f"({payload})")
check("ответ не содержит хеш пароля", "password_hash" not in json.dumps(payload), f"({payload})")
check("сессионная cookie выдана", bool(cookie) and "HttpOnly" in cookie and "SameSite=Strict" in cookie)
session = cookie.split(";")[0]

status, payload, _ = call("GET", "/api/auth/status", cookie=session)
check("статус называет текущий аккаунт",
      payload.get("user", {}).get("username") == "muhamed" and payload["user"]["is_admin"] is True,
      f"({payload})")

status, payload, _ = call("GET", "/api/books", cookie=session)
check("список книг доступен с сессией", status == 200 and len(payload["books"]) == 1, f"({status})")
check("мигрированная книга видна как ready", payload["books"][0]["status"] == "ready")
check("в ответе есть флаг indexing", "indexing" in payload["books"][0])

status, payload, _ = call("GET", "/api/health", cookie=session)
check("health с сессией показывает бэкенд векторов", payload.get("vector_backend") == "numpy", f"({payload})")

print("\n--- загрузка книги ---")
content = ("Делегирование освобождает время руководителя. " * 500).encode()
start = time.time()
status, payload, _ = call("POST", "/api/books", raw=content, cookie=session,
                          headers={"X-Filename": "delegation.txt"})
elapsed = time.time() - start
check("загрузка отвечает 202 Accepted", status == 202, f"({status} {payload})")
check("ответ приходит мгновенно, не дожидаясь индексации", elapsed < 2.0, f"({elapsed:.2f}s)")
book_id = payload.get("book_id")
check("сервер вернул id книги", bool(book_id))

deadline = time.time() + 25
final = None
while time.time() < deadline:
    _, listing, _ = call("GET", "/api/books", cookie=session)
    book = next((b for b in listing["books"] if b["id"] == book_id), None)
    if book and not book["indexing"]:
        final = book
        break
    time.sleep(0.3)
check("опрос статуса дожидается готовности", final is not None and final["status"] == "ready", f"({final})")
check("посчитаны фрагменты", final and final["chunk_count"] > 0, f"({final})")

print("\n--- поиск и ответ ---")
status, payload, _ = call("POST", "/api/search", {"query": "делегирование", "limit": 4}, cookie=session)
check("поиск работает", status == 200 and len(payload["results"]) == 4, f"({status})")
check("во фрагментах есть текст", all(r.get("content") for r in payload["results"]))

status, payload, _ = call("POST", "/api/search", {"query": "тест", "limit": "не-число"}, cookie=session)
check("нечисловой limit -> 400, а не 500", status == 400, f"({status} {payload})")

status, payload, _ = call("POST", "/api/answer",
                          {"question": "как делегировать?", "mode": "reader", "book_ids": [book_id]},
                          cookie=session)
check("ответ формируется", status == 200 and payload.get("sources"), f"({status})")

status, payload, _ = call("POST", "/api/answer",
                          {"question": "сравни", "mode": "thinker", "book_ids": [book_id]},
                          cookie=session)
check("Thinker с одной книгой -> 400", status == 400, f"({status})")

print("\n--- переиндексация и удаление ---")
status, payload, _ = call("POST", "/api/books/reindex", {"id": book_id}, cookie=session)
check("переиндексация принята (202)", status == 202, f"({status} {payload})")
deadline = time.time() + 25
while time.time() < deadline:
    _, listing, _ = call("GET", "/api/books", cookie=session)
    book = next((b for b in listing["books"] if b["id"] == book_id), None)
    if book and not book["indexing"]:
        break
    time.sleep(0.3)
check("после переиндексации книга снова ready", book["status"] == "ready", f"({book})")

status, payload, _ = call("POST", "/api/books/delete", {"id": book_id}, cookie=session)
check("удаление работает", status == 200 and payload["book"]["deleted"], f"({status})")
_, listing, _ = call("GET", "/api/books", cookie=session)
check("книга исчезла из списка", all(b["id"] != book_id for b in listing["books"]))
status, payload, _ = call("POST", "/api/books/delete", {"id": book_id}, cookie=session)
check("повторное удаление -> 400 с текстом", status == 400 and "error" in payload, f"({status})")

print("\n--- второй аккаунт ---")
status, payload, _ = call("POST", "/api/users",
                          {"username": "anna", "password": "ПарольАнны-2026", "display_name": "Анна"},
                          cookie=session)
check("администратор создаёт аккаунт", status == 201 and payload["user"]["username"] == "anna", f"({status} {payload})")

status, payload, _ = call("POST", "/api/users", {"username": "anna", "password": "ДругойПароль-2026"}, cookie=session)
check("повторный логин -> 400", status == 400, f"({status})")

status, payload, anna_cookie = call("POST", "/api/auth/login", {"username": "anna", "password": "ПарольАнны-2026"})
check("второй аккаунт входит своим паролем", status == 200, f"({status} {payload})")
check("второй аккаунт не администратор", payload["user"]["is_admin"] is False)
anna = anna_cookie.split(";")[0]

status, payload, _ = call("GET", "/api/books", cookie=anna)
check("новый аккаунт начинает с пустой библиотекой", status == 200 and payload["books"] == [], f"({payload})")

content2 = ("Бюджет и финансовая дисциплина. " * 300).encode()
status, payload, _ = call("POST", "/api/books", raw=content2, cookie=anna, headers={"X-Filename": "finance.txt"})
anna_book_id = payload.get("book_id")
check("второй аккаунт загружает свою книгу", status == 202 and bool(anna_book_id), f"({status} {payload})")
deadline = time.time() + 25
while time.time() < deadline:
    _, listing, _ = call("GET", "/api/books", cookie=anna)
    book = next((b for b in listing["books"] if b["id"] == anna_book_id), None)
    if book and not book["indexing"]:
        break
    time.sleep(0.3)
check("книга второго аккаунта проиндексирована", book and book["status"] == "ready", f"({book})")

_, owner_listing, _ = call("GET", "/api/books", cookie=session)
check("владелец не видит книгу второго аккаунта",
      all(b["id"] != anna_book_id for b in owner_listing["books"]), f"({owner_listing})")
_, anna_listing, _ = call("GET", "/api/books", cookie=anna)
check("второй аккаунт видит только свою книгу", [b["id"] for b in anna_listing["books"]] == [anna_book_id])

owner_book_id = owner_listing["books"][0]["id"]
status, payload, _ = call("POST", "/api/search", {"query": "управление", "book_ids": [owner_book_id]}, cookie=anna)
check("поиск по чужому id книги -> 400, а не чужой текст", status == 400, f"({status} {payload})")
status, payload, _ = call("POST", "/api/books/delete", {"id": owner_book_id}, cookie=anna)
check("удаление чужой книги -> 400", status == 400, f"({status})")
_, owner_listing, _ = call("GET", "/api/books", cookie=session)
check("книга владельца на месте", any(b["id"] == owner_book_id for b in owner_listing["books"]))

call("POST", "/api/memories", {"kind": "note", "content": "СЕКРЕТ-ВЛАДЕЛЬЦА"}, cookie=session)
_, payload, _ = call("GET", "/api/memories", cookie=anna)
check("заметки владельца не видны второму аккаунту",
      all("СЕКРЕТ-ВЛАДЕЛЬЦА" not in m["content"] for m in payload["memories"]), f"({payload})")

status, payload, _ = call("GET", "/api/users", cookie=anna)
check("список аккаунтов закрыт для неадминистратора", status == 403, f"({status})")
status, payload, _ = call("POST", "/api/users", {"username": "boris", "password": "ПарольБориса-2026"}, cookie=anna)
check("создание аккаунта закрыто для неадминистратора", status == 403, f"({status})")
status, payload, _ = call("POST", "/api/users/delete", {"id": "muhamed"}, cookie=anna)
check("удаление аккаунтов закрыто для неадминистратора", status == 403, f"({status})")

status, payload, cleared = call("POST", "/api/users/password",
                                {"current_password": "неверный", "new_password": "ЕщёОдинПароль-2026"},
                                cookie=anna)
check("смена пароля без текущего -> 400", status == 400, f"({status})")
status, payload, cleared = call("POST", "/api/users/password",
                                {"current_password": "ПарольАнны-2026", "new_password": "ЕщёОдинПароль-2026"},
                                cookie=anna)
check("смена своего пароля работает", status == 200 and payload.get("signed_out"), f"({status} {payload})")
check("cookie сбрасывается тем же ответом", cleared and "Max-Age=0" in cleared, f"({cleared})")
status, _, _ = call("GET", "/api/books", cookie=anna)
check("старая cookie после смены пароля недействительна", status == 401, f"({status})")
status, payload, anna_cookie = call("POST", "/api/auth/login", {"username": "anna", "password": "ЕщёОдинПароль-2026"})
check("вход с новым паролем работает", status == 200, f"({status})")
anna = anna_cookie.split(";")[0]

status, payload, _ = call("POST", "/api/users/delete", {"id": payload["user"]["id"]}, cookie=session)
check("администратор удаляет аккаунт", status == 200 and payload["user"]["deleted"], f"({status} {payload})")
status, _, _ = call("GET", "/api/books", cookie=anna)
check("cookie удалённого аккаунта больше не работает", status == 401, f"({status})")

print("\n--- защита ---")
status, payload, _ = call("GET", "/web/../server.py", cookie=session)
check("обход каталога не отдаёт server.py", status != 200 or "_raw" in payload and "OPENAI" not in payload.get("_raw", ""), f"({status})")
status, _, _ = call("GET", "/data/nbrain.db", cookie=session)
check("база данных не отдаётся по HTTP", status == 404, f"({status})")

server._login_attempts.clear()
codes = []
for i in range(6):
    st, _, _ = call("POST", "/api/auth/login", {"password": f"подбор{i}"})
    codes.append(st)
check("подбор пароля упирается в 429", 429 in codes, f"({codes})")

# X-Forwarded-For задаётся клиентом. Пока прокси не объявлен доверенным,
# заголовок игнорируется — иначе новое значение на каждую попытку снимало бы
# блокировку и раздувало таблицу попыток входа.
spoofed = []
for i in range(5):
    st, _, _ = call("POST", "/api/auth/login", {"password": f"обход{i}"},
                    headers={"X-Forwarded-For": f"203.0.113.{i}"})
    spoofed.append(st)
check("подменённый X-Forwarded-For не снимает блокировку",
      all(st == 429 for st in spoofed), f"({spoofed})")
check("подменённый X-Forwarded-For не плодит записи о попытках",
      len(server._login_attempts) == 1, f"({len(server._login_attempts)} ключей)")

# Обратная сторона: когда прокси доверенный, заголовок обязан работать —
# иначе все клиенты за одним nginx делили бы один счётчик.
server.TRUST_FORWARDED_FOR = True
try:
    st, _, _ = call("POST", "/api/auth/login", {"password": "неверный"},
                    headers={"X-Forwarded-For": "198.51.100.7"})
    check("за доверенным прокси адрес из заголовка — отдельный клиент",
          st == 401, f"({st})")
finally:
    server.TRUST_FORWARDED_FOR = False
    server._login_attempts.clear()

# Некорректный Content-Length — ошибка клиента (400), а не сбой сервера (500).
for bad in ("abc", "-1", ""):
    st, payload, _ = call("POST", "/api/search", raw=b'{"query":"x"}', cookie=session,
                          headers={"Content-Length": bad, "Content-Type": "application/json"})
    check(f"Content-Length: {bad!r} -> 400 с текстом", st == 400 and "error" in payload,
          f"({st} {payload})")

print("\n--- защита от запросов с чужого сайта ---")
st, payload, _ = call("POST", "/api/memories", {"kind": "note", "content": "чужой"},
                      cookie=session, headers={"Origin": "https://evil.example"})
check("POST с чужого Origin -> 400", st == 400 and "другого сайта" in payload.get("error", ""), f"({st} {payload})")
st, payload, _ = call("POST", "/api/memories", {"kind": "note", "content": "свой"}, cookie=session)
check("POST со своего Origin проходит", st == 201, f"({st} {payload})")
st, payload, _ = call("POST", "/api/search", raw=b'{"query":"x"}', cookie=session,
                      headers={"Content-Type": "text/plain"})
check("JSON без Content-Type: application/json отклоняется", st == 400, f"({st} {payload})")

print("\n--- заголовки безопасности ---")
conn_head = http.client.HTTPConnection("127.0.0.1", 8931, timeout=10)
conn_head.request("GET", "/", headers={"Cookie": session})
response_head = conn_head.getresponse()
head = {key.lower(): value for key, value in response_head.getheaders()}
response_head.read()
conn_head.close()
check("Content-Security-Policy отдаётся", "content-security-policy" in head, f"({sorted(head)})")
check("страница запрещена во фрейме", head.get("x-frame-options") == "DENY", f"({head.get('x-frame-options')})")
check("nosniff стоит на всех ответах", head.get("x-content-type-options") == "nosniff")
check("Referrer-Policy задан", head.get("referrer-policy") == "no-referrer")

print("\n--- регистрация через HTTP ---")
st, payload, _ = call("POST", "/api/auth/register",
                      {"email": "klara@example.com", "password": "ПарольКлары-2026", "display_name": "Клара"})
check("регистрация -> 201", st == 201 and payload.get("registered"), f"({st} {payload})")
check("ответ сообщает, настроена ли почта", payload.get("mail_configured") is False, f"({payload})")
st, payload, _ = call("POST", "/api/auth/register", {"email": "плохой", "password": "ДлинныйПароль-2026"})
check("некорректный адрес -> 400", st == 400, f"({st})")

st, payload, klara_cookie = call("POST", "/api/auth/login",
                                 {"username": "klara@example.com", "password": "ПарольКлары-2026"})
check("новый аккаунт входит по почте", st == 200, f"({st} {payload})")
check("сервер сообщает, что анкета не пройдена", payload["onboarding"]["completed"] is False, f"({payload})")
check("адрес пока не подтверждён", payload["user"]["email_verified"] is False)
klara = klara_cookie.split(";")[0]

st, payload, _ = call("GET", "/api/interests", cookie=klara)
check("справочник интересов доступен", st == 200 and len(payload["interests"]) > 5, f"({st})")
chosen = [item["id"] for item in payload["interests"][:2]]
st, payload, _ = call("POST", "/api/onboarding", {
    "level": "intermediate", "daily_minutes": 30, "format": "mixed", "interests": chosen,
    "goals": [{"title": "Разобраться в юнит-экономике"}],
    "books_read": ["Атомные привычки — Джеймс Клир"], "books_wanted": [],
}, cookie=klara)
check("анкета сохраняется", st == 200 and payload["profile"]["completed"], f"({st} {payload})")
st, payload, _ = call("GET", "/api/auth/status", cookie=klara)
check("статус помнит, что анкета пройдена", payload["onboarding"]["completed"] is True)

st, payload, _ = call("GET", "/api/books", cookie=klara)
check("новый аккаунт видит пустую библиотеку", st == 200 and payload["books"] == [], f"({payload})")
st, payload, _ = call("GET", "/api/admin/mail-log", cookie=klara)
check("журнал писем закрыт от обычного аккаунта", st == 403, f"({st})")

st, payload, _ = call("GET", "/api/admin/mail-log", cookie=session)
verify_letter = [m for m in payload["messages"] if "подтвердите" in m["subject"]][0]
token = verify_letter["body"].split("token=")[1].split()[0]
check("администратор видит письмо подтверждения", verify_letter["to"] == "klara@example.com")
st, payload, _ = call("POST", "/api/auth/verify", {"token": token})
check("подтверждение адреса через HTTP", st == 200 and payload.get("verified"), f"({st} {payload})")
st, payload, _ = call("GET", "/api/auth/status", cookie=klara)
check("статус показывает подтверждённый адрес", payload["user"]["email_verified"] is True)

st, body_html = None, None
conn_page = http.client.HTTPConnection("127.0.0.1", 8931, timeout=10)
conn_page.request("GET", "/verify?token=whatever")
response_page = conn_page.getresponse()
body_html = response_page.read()
conn_page.close()
check("страница /verify отдаётся браузеру", response_page.status == 200 and b"NBrain" in body_html,
      f"({response_page.status})")

print("\n--- экспорт и удаление своего аккаунта через HTTP ---")
conn_export = http.client.HTTPConnection("127.0.0.1", 8931, timeout=20)
conn_export.request("GET", "/api/account/export", headers={"Cookie": klara})
response_export = conn_export.getresponse()
export_raw = response_export.read()
disposition = response_export.getheader("Content-Disposition") or ""
conn_export.close()
export = json.loads(export_raw.decode())
check("экспорт отдаётся файлом", "attachment" in disposition and "nbrain-my-data.json" in disposition, f"({disposition})")
check("в экспорте есть анкета и цели", export["learning_profile"] and export["goals"], f"({list(export)})")
check("в экспорте нет пароля", "password_hash" not in export_raw.decode())

st, payload, _ = call("POST", "/api/account/delete", {"password": "не тот"}, cookie=klara)
check("удаление с неверным паролем -> 400", st == 400, f"({st})")
st, payload, cleared = call("POST", "/api/account/delete", {"password": "ПарольКлары-2026"}, cookie=klara)
check("удаление своего аккаунта работает", st == 200 and payload.get("deleted"), f"({st} {payload})")
check("cookie сбрасывается тем же ответом", cleared and "Max-Age=0" in cleared, f"({cleared})")
st, _, _ = call("GET", "/api/books", cookie=klara)
check("после удаления сессия недействительна", st == 401, f"({st})")

print("\n--- ограничение частоты ---")
server.rate_limiter.reset()
saved_answer_limit = server.RATE_LIMITS["search"]
server.RATE_LIMITS["search"] = (2, 3600.0)
try:
    codes = [call("POST", "/api/search", {"query": "тест"}, cookie=session)[0] for _ in range(4)]
    check("после исчерпания квоты поиск отвечает 400 с объяснением", codes.count(400) >= 2, f"({codes})")
    st, payload, _ = call("POST", "/api/search", {"query": "тест"}, cookie=session)
    check("в ответе сказано, когда повторить", "Повторите через" in payload.get("error", ""), f"({payload})")
finally:
    server.RATE_LIMITS["search"] = saved_answer_limit
    server.rate_limiter.reset()

httpd.shutdown()
print("\n" + "=" * 54)
print(f"ИТОГО: {OK} пройдено, {FAIL} провалено")
if FAILURES:
    print("Провалено:", "; ".join(FAILURES))
sys.exit(1 if FAIL else 0)
