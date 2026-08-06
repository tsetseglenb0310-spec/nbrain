import hashlib, json, os, random, sys, tempfile, time, zipfile
from pathlib import Path

WORK = Path(tempfile.mkdtemp(prefix="nbdata-"))
os.environ.update({
    "NBRAIN_DATA_DIR": str(WORK),
    "OPENAI_API_KEY": "test-key",
    "NBRAIN_AUTH_REQUIRED": "1",
    "NBRAIN_ADMIN_PASSWORD": "МойСложныйПароль-2026",   # кириллица — прежний баг
    "NBRAIN_ADMIN_USERNAME": "muhamed",
    "NBRAIN_SESSION_SECRET": "x" * 48,
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server

DIM = 64


def fake_embed(path, payload):
    assert path == "embeddings", path
    out = []
    for text in payload["input"]:
        rnd = random.Random(hashlib.sha256(text.encode()).hexdigest())
        out.append({"embedding": [rnd.uniform(-1, 1) for _ in range(DIM)]})
    fake_embed.calls += 1
    return {"data": out}


fake_embed.calls = 0
server.openai_request = fake_embed

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


def raises(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except server.ClientError:
        return True
    except Exception:
        return False
    return False


def _all_token_rows():
    with server.db() as conn:
        return [tuple(row) for row in conn.execute("SELECT * FROM auth_tokens").fetchall()]


def wait_ready(book_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with server.db() as conn:
            row = conn.execute("SELECT status, error FROM books WHERE id = ?", (book_id,)).fetchone()
        if row and row["status"] != "indexing":
            return row["status"], row["error"]
        time.sleep(0.05)
    return "timeout", None


print("\n=== 1. Аккаунты, пароль и сессия ===")
server.init_storage()
OWNER = server.primary_user()
UID = OWNER["id"]
check("первый аккаунт создан из NBRAIN_ADMIN_USERNAME", OWNER["username"] == "muhamed", f"({OWNER['username']})")
check("первый аккаунт — администратор", bool(OWNER["is_admin"]))
check("пароль не хранится в открытом виде",
      "МойСложныйПароль-2026" not in (OWNER["password_hash"] + OWNER["password_salt"]))
check("кириллический пароль принимается",
      server.verify_password("МойСложныйПароль-2026", OWNER["password_hash"], OWNER["password_salt"]))
check("неверный пароль отклоняется",
      not server.verify_password("wrong", OWNER["password_hash"], OWNER["password_salt"]))
check("у профиля владельца есть карточка", server.get_profile(UID)["name"] == server.DEFAULT_DIRECTOR_NAME)

token = server.make_session_token(OWNER)
check("свежая сессия валидна", server.session_is_valid(f"nbrain_session={token}"))
check("сессия указывает на своего владельца",
      server.session_user(f"nbrain_session={token}")["id"] == UID)
check("подделанная подпись отклоняется", not server.session_is_valid(f"nbrain_session={UID}.99999999999.deadbeef"))
expired = server.sign_session(UID, "1", server.user_fingerprint(OWNER["password_hash"]))
check("истёкший срок отклоняется", not server.session_is_valid(f"nbrain_session={UID}.1.{expired}"))
check("мусор в cookie не роняет сервер", not server.session_is_valid("nbrain_session=garbage"))
check("cookie неизвестного пользователя отклоняется",
      not server.session_is_valid(f"nbrain_session=нет-такого.99999999999.{expired}"))

ANNA = server.create_user({"username": "Anna", "password": "ПарольАнны-2026", "display_name": "Анна"})
AID = ANNA["id"]
check("логин приводится к нижнему регистру", ANNA["username"] == "anna", f"({ANNA['username']})")
check("новый аккаунт не администратор", ANNA["is_admin"] is False)
check("у нового аккаунта сразу свой профиль", server.get_profile(AID)["name"] == "Анна")
check("занятый логин отклоняется",
      raises(server.create_user, {"username": "anna", "password": "ЕщёОдинПароль"}))
check("короткий пароль отклоняется",
      raises(server.create_user, {"username": "boris", "password": "1234"}))
for bad in ("ab", "Анна", "with space", "a" * 40, "-начинается-с-дефиса"):
    check(f"некорректный логин {bad!r} отклоняется",
          raises(server.create_user, {"username": bad, "password": "ДлинныйПароль-2026"}))

anna_token = server.make_session_token(server.get_user(AID))
server.set_user_password(AID, "НовыйПарольАнны-2026")
check("смена пароля инвалидирует cookie этого аккаунта",
      not server.session_is_valid(f"nbrain_session={anna_token}"))
check("cookie другого аккаунта при этом жива", server.session_is_valid(f"nbrain_session={token}"))
check("удалить аккаунт, под которым вошли, нельзя", raises(server.delete_user, UID, UID))
check("удалить последнего администратора нельзя",
      raises(server.delete_user, UID, AID))

print("\n=== 2. Троттлинг входа ===")
server._login_attempts.clear()
check("первая попытка без задержки", server.login_throttle("1.2.3.4") == 0)
for _ in range(3):
    server.record_login_failure("1.2.3.4")
check("3 неудачи ещё бесплатны", server.login_throttle("1.2.3.4") == 0)
server.record_login_failure("1.2.3.4")
check("4-я неудача даёт задержку", server.login_throttle("1.2.3.4") > 0)
for _ in range(6):
    server.record_login_failure("1.2.3.4")
check("10 неудач = длительная блокировка", server.login_throttle("1.2.3.4") > 300)
check("другой IP не затронут", server.login_throttle("5.6.7.8") == 0)
server.clear_login_failures("1.2.3.4")
check("успешный вход сбрасывает счётчик", server.login_throttle("1.2.3.4") == 0)

print("\n=== 3. Векторы ===")
vec = [random.uniform(-1, 1) for _ in range(DIM)]
blob = server.pack_vector(vec)
check("blob = 4 байта на число", len(blob) == DIM * 4, f"({len(blob)})")
restored = list(server.unpack_vector(blob))
norm = sum(v * v for v in restored) ** 0.5
check("вектор нормализован при записи", abs(norm - 1.0) < 1e-5, f"(норма {norm})")
target = server.normalize_vector(vec)
blobs = [server.pack_vector([random.uniform(-1, 1) for _ in range(DIM)]) for _ in range(50)]
blobs.insert(17, blob)
ranked = server.rank_by_similarity(target, blobs, 5)
check("идентичный вектор занимает первое место", ranked[0][0] == 17 and ranked[0][1] > 0.99, f"({ranked[0]})")
check("оценки убывают", all(ranked[i][1] >= ranked[i + 1][1] for i in range(len(ranked) - 1)))
saved_np = server._np
server._np = None
ranked_py = server.rank_by_similarity(target, blobs, 5)
server._np = saved_np
check("fallback без numpy даёт тот же топ", [i for i, _ in ranked_py] == [i for i, _ in ranked])
check("оценки numpy и pure-python совпадают",
      all(abs(a[1] - b[1]) < 1e-4 for a, b in zip(ranked, ranked_py)))
check("несовпадение размерности ловится",
      raises(server.rank_by_similarity, target, [server.pack_vector([1.0] * (DIM + 8))], 1))

print("\n=== 4. EPUB читается в порядке spine ===")
epub_path = WORK / "order.epub"
chapters = {
    "OEBPS/c1.xhtml": "<html><body><p>Глава первая про стратегию</p></body></html>",
    "OEBPS/c2.xhtml": "<html><body><p>Глава вторая про команду</p></body></html>",
    "OEBPS/c10.xhtml": "<html><body><p>Глава десятая про итоги</p></body></html>",
    "OEBPS/nav.xhtml": "<html><body><p>ОГЛАВЛЕНИЕ НЕ ДОЛЖНО ПОПАСТЬ</p></body></html>",
    "OEBPS/cover.xhtml": "<html><body><p>ОБЛОЖКА НЕ ДОЛЖНА ПОПАСТЬ</p></body></html>",
}
opf = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c10" href="c10.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    <itemref idref="nav"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c10"/>
  </spine>
</package>"""
container = """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""
with zipfile.ZipFile(epub_path, "w") as zf:
    zf.writestr("META-INF/container.xml", container)
    zf.writestr("OEBPS/content.opf", opf)
    # Порядок в архиве специально ломает старую версию: c1, c10, c2.
    for name in ("OEBPS/nav.xhtml", "OEBPS/cover.xhtml", "OEBPS/c1.xhtml", "OEBPS/c10.xhtml", "OEBPS/c2.xhtml"):
        zf.writestr(name, chapters[name])
pages = server.read_epub(epub_path)
texts = [text for _, text in pages]
check("порядок глав — 1, 2, 10 (а не 1, 10, 2)",
      len(texts) == 3 and "первая" in texts[0] and "вторая" in texts[1] and "десятая" in texts[2],
      f"({texts})")
check("оглавление (nav) исключено", not any("ОГЛАВЛЕНИЕ" in t for t in texts))
check("обложка (linear=no) исключена", not any("ОБЛОЖКА" in t for t in texts))
check("страницы нумеруются подряд с 1", [p for p, _ in pages] == [1, 2, 3])

with zipfile.ZipFile(WORK / "broken.epub", "w") as zf:
    zf.writestr("a.xhtml", "<html><body>текст без spine</body></html>")
check("EPUB без spine всё равно читается", len(server.read_epub(WORK / "broken.epub")) == 1)

print("\n=== 5. Загрузка, индексация, поиск ===")
book_path = server.UPLOADS_DIR / "b1_strategy.txt"
book_path.write_text(
    "Стратегия компании строится на выборе приоритетов. " * 400
    + "Команда растёт через делегирование и обратную связь. " * 400
    + "Метрики успеха измеряют результат, а не усилия. " * 400,
    encoding="utf-8",
)
with server.db() as conn:
    conn.execute(
        "INSERT INTO books (id, user_id, filename, title, extension, stored_path, status, created_at) VALUES (?,?,?,?,?,?,'indexing',?)",
        ("b1", UID, "strategy.txt", "Стратегия", ".txt", str(book_path), server.now_iso()),
    )
server.start_indexing("b1", book_path)
status, err = wait_ready("b1")
check("фоновая индексация завершилась статусом ready", status == "ready", f"({status} / {err})")

with server.db() as conn:
    row = conn.execute(
        "SELECT COUNT(*) c, SUM(LENGTH(embedding_json)) j, SUM(LENGTH(embedding_vec)) v FROM chunks WHERE book_id='b1'"
    ).fetchone()
check("чанки записаны", row["c"] > 0, f"({row['c']})")
check("embedding_json больше не заполняется", (row["j"] or 0) == 0)
check("embedding_vec заполнен float32", row["v"] == row["c"] * DIM * 4, f"({row['v']} vs {row['c'] * DIM * 4})")

results = server.search(UID, "делегирование и обратная связь", limit=3)
check("поиск возвращает результаты", len(results) == 3, f"({len(results)})")
check("у результата есть текст фрагмента", bool(results[0].get("content")))
check("у результата есть название книги", results[0].get("title") == "Стратегия")
check("оценки в разумном диапазоне", all(-1.01 <= r["score"] <= 1.01 for r in results))
check("оценки отсортированы по убыванию",
      all(results[i]["score"] >= results[i + 1]["score"] for i in range(len(results) - 1)))

print("\n=== 6. Thinker: один эмбеддинг вместо N ===")
book2 = server.UPLOADS_DIR / "b2_team.txt"
book2.write_text("Управление командой требует доверия и ясных ожиданий. " * 120, encoding="utf-8")
with server.db() as conn:
    conn.execute(
        "INSERT INTO books (id, user_id, filename, title, extension, stored_path, status, created_at) VALUES (?,?,?,?,?,?,'indexing',?)",
        ("b2", UID, "team.txt", "Команда", ".txt", str(book2), server.now_iso()),
    )
server.start_indexing("b2", book2)
check("вторая книга проиндексирована", wait_ready("b2")[0] == "ready")

before = fake_embed.calls
sources = server.sources_for_answer(UID, "как выстроить доверие в команде", "thinker", ["b1", "b2"])
check("Thinker по 2 книгам = ровно 1 запрос эмбеддинга", fake_embed.calls - before == 1,
      f"({fake_embed.calls - before})")
check("Thinker вернул по фрагменту на книгу", len({s["book_id"] for s in sources}) == 2)

before = fake_embed.calls
deep = server.sources_for_answer(UID, "о чём эта книга", "reader", ["b1"], "deep")
check("Deep-разбор = 1 запрос эмбеддинга", fake_embed.calls - before == 1)
check("Deep-разбор собирает фрагменты по всей книге", len(deep) > 7, f"({len(deep)})")
check("в deep нет дублей", len({s["id"] for s in deep}) == len(deep))

print("\n=== 7. Переиндексация и удаление ===")
with server.db() as conn:
    conn.execute("UPDATE chunks SET embedding_model = 'старая-модель' WHERE book_id = 'b1'")
check("книга со старой моделью выпадает из поиска", raises(server.search, UID, "приоритеты", 3, ["b1"]))
try:
    server.search(UID, "приоритеты", 3, ["b1"])
except server.ClientError as e:
    check("ошибка объясняет причину и путь решения", "переиндекс" in str(e).lower(), f"({e})")
server.reindex_book(UID, "b1")
check("после переиндексации статус ready", wait_ready("b1")[0] == "ready")
check("поиск по книге снова работает", len(server.search(UID, "приоритеты", 3, ["b1"])) > 0)

with server.db() as conn:
    chunks_before = conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
server.delete_book(UID, "b2")
with server.db() as conn:
    left = conn.execute("SELECT COUNT(*) c FROM books WHERE id='b2'").fetchone()["c"]
    chunks_after = conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
check("книга удалена", left == 0)
check("чанки удалены каскадом", chunks_after < chunks_before, f"({chunks_before} -> {chunks_after})")
check("файл книги удалён с диска", not book2.exists())
check("удаление несуществующей книги даёт ClientError", raises(server.delete_book, UID, "нет-такой"))
check("переиндексация несуществующей книги даёт ClientError", raises(server.reindex_book, UID, "нет-такой"))

print("\n=== 8. Понятные ошибки поиска ===")
with server.db() as conn:
    conn.execute(
        "INSERT INTO books (id, user_id, filename, title, extension, stored_path, status, created_at) VALUES ('b3',?,'x.txt','X','.txt','/nope','failed',?)",
        (UID, server.now_iso()),
    )
try:
    server.search(UID, "что угодно", 3, ["b3"])
except server.ClientError as e:
    check("для failed-книги ошибка говорит про ошибку индексации", "ошибк" in str(e).lower(), f"({e})")
try:
    server.search(UID, "что угодно", 3, ["нет-такой-книги"])
except server.ClientError as e:
    check("для несуществующей книги ошибка говорит об этом", "не найден" in str(e).lower(), f"({e})")
check("пустой запрос отклоняется", raises(server.embed_query, "   "))

print("\n=== 9. Сопоставление каталога с загруженными книгами ===")
uploaded = [server.normalize_catalog_text("Лидерство без титулов")]
check("«Лидер» больше не матчится с «Лидерство без титулов»",
      not server.catalog_has_uploaded_source("Лидер", uploaded))
check("точное совпадение находится",
      server.catalog_has_uploaded_source("Лидерство без титулов", uploaded))
check("совпадение с подзаголовком находится",
      server.catalog_has_uploaded_source("Лидерство без титулов: практика", uploaded))
check("посторонняя книга не матчится",
      not server.catalog_has_uploaded_source("Стратегия голубого океана", uploaded))

print("\n=== 10. Прочие защиты ===")
check("overview с limit=1 не падает", len(server.overview_sources(UID, "b1", 1)) == 1)
check("overview для несуществующей книги — ClientError", raises(server.overview_sources, UID, "нет", 8))
check("двойная индексация одной книги блокируется",
      server.start_indexing("busy", Path("/nope")) and not server.start_indexing("busy", Path("/nope")))
# Очередь индексации ограничена: серия загрузок не должна порождать
# неограниченное число тяжёлых обработок и параллельных запросов к API.
server._indexing_queued.update(f"q{i}" for i in range(server.MAX_INDEXING_QUEUE))
check("переполнение очереди индексации -> ClientError",
      raises(server.start_indexing, "лишняя", Path("/nope")))
server._indexing_queued.clear()
check("после освобождения очереди книга снова принимается",
      server.start_indexing("после-очереди", Path("/nope")))

print("\n=== 11. Разбор Content-Length ===")
check("нормальное значение проходит", server.parse_content_length("42", 100, "нельзя") == 42)
for bad in ("abc", "", "-1", None, "0", "1e3", " 7 7 "):
    check(f"мусорный Content-Length {bad!r} -> ClientError",
          raises(server.parse_content_length, bad, 100, "нельзя"))
check("превышение лимита -> ClientError", raises(server.parse_content_length, "101", 100, "нельзя"))
check("пробелы вокруг числа допустимы", server.parse_content_length(" 42 ", 100, "нельзя") == 42)

print("\n=== 12. Защита от ZIP-бомб ===")
bomb = WORK / "bomb.epub"
with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as zf:
    # 4 МБ нулей сжимаются в единицы килобайт — ровно так и строится ZIP-бомба.
    zf.writestr("META-INF/container.xml", container)
    zf.writestr("OEBPS/big.xhtml", "<html><body>" + "0" * (4 * 1024 * 1024) + "</body></html>")
compressed = bomb.stat().st_size
check("бомба действительно мала на диске", compressed < 64 * 1024, f"({compressed} Б)")

saved = (server.MAX_ARCHIVE_TOTAL_BYTES, server.MAX_ARCHIVE_ENTRY_BYTES, server.MAX_ARCHIVE_ENTRIES)
try:
    server.MAX_ARCHIVE_TOTAL_BYTES = 1024 * 1024
    server.MAX_ARCHIVE_ENTRY_BYTES = 1024 * 1024
    check("распакованный размер выше лимита -> ClientError", raises(server.read_epub, bomb))
    try:
        server.read_epub(bomb)
    except server.ClientError as e:
        check("ошибка объясняет, что дело в распакованном размере",
              "распакованн" in str(e).lower(), f"({e})")
    server.MAX_ARCHIVE_TOTAL_BYTES, server.MAX_ARCHIVE_ENTRY_BYTES = saved[0], saved[1]
    server.MAX_ARCHIVE_ENTRIES = 3
    many = WORK / "many.epub"
    with zipfile.ZipFile(many, "w") as zf:
        for i in range(10):
            zf.writestr(f"p{i}.xhtml", "<html><body>текст</body></html>")
    check("слишком много элементов в архиве -> ClientError", raises(server.read_epub, many))
finally:
    server.MAX_ARCHIVE_TOTAL_BYTES, server.MAX_ARCHIVE_ENTRY_BYTES, server.MAX_ARCHIVE_ENTRIES = saved
check("нормальный EPUB после проверки читается как раньше", len(server.read_epub(epub_path)) == 3)

print("\n=== 13. Таблица попыток входа ограничена ===")
server._login_attempts.clear()
for i in range(server.LOGIN_MAX_TRACKED_CLIENTS + 500):
    server.record_login_failure(f"203.0.113.{i}")
check("словарь попыток не растёт без предела",
      len(server._login_attempts) <= server.LOGIN_MAX_TRACKED_CLIENTS,
      f"({len(server._login_attempts)})")
check("последний клиент не вытеснен", "203.0.113.4595" in server._login_attempts)
server._login_attempts.clear()
old = time.time() - server.LOGIN_ATTEMPT_TTL_SECONDS - 1
server._login_attempts["древний"] = [old]
server.login_throttle("свежий")
check("устаревшие записи удаляются", "древний" not in server._login_attempts)
check("клиент без провалов не занимает место", "свежий" not in server._login_attempts)

print("\n=== 14. Изоляция данных между аккаунтами ===")
# Анна работает со своей библиотекой; ничто из данных владельца не должно
# быть ей видно, даже если она подставит чужой id книги напрямую.
anna_book = server.UPLOADS_DIR / "a1_finance.txt"
anna_book.write_text("Финансовая дисциплина начинается с бюджета. " * 200, encoding="utf-8")
with server.db() as conn:
    conn.execute(
        "INSERT INTO books (id, user_id, filename, title, extension, stored_path, status, created_at) VALUES (?,?,?,?,?,?,'indexing',?)",
        ("a1", AID, "finance.txt", "Финансы", ".txt", str(anna_book), server.now_iso()),
    )
server.start_indexing("a1", anna_book)
check("книга второго аккаунта проиндексирована", wait_ready("a1")[0] == "ready")

check("владелец видит только свои книги",
      {b["id"] for b in server.list_books(UID)} == {"b1", "b3"},
      f"({[b['id'] for b in server.list_books(UID)]})")
check("второй аккаунт видит только свою книгу",
      [b["id"] for b in server.list_books(AID)] == ["a1"])

anna_results = server.search(AID, "бюджет и дисциплина", limit=3)
check("поиск второго аккаунта не выходит за его библиотеку",
      all(r["book_id"] == "a1" for r in anna_results), f"({[r['book_id'] for r in anna_results]})")
check("явный чужой book_id ничего не возвращает",
      raises(server.search, AID, "приоритеты", 3, ["b1"]))
check("overview по чужой книге запрещён", raises(server.overview_sources, AID, "b1", 4))
check("переиндексация чужой книги запрещена", raises(server.reindex_book, AID, "b1"))
check("удаление чужой книги запрещено", raises(server.delete_book, AID, "b1"))
check("чужая книга осталась на месте", any(b["id"] == "b1" for b in server.list_books(UID)))

server.save_memory(UID, {"kind": "note", "content": "заметка владельца"})
server.create_action(UID, {"title": "действие владельца"})
server.save_memory(AID, {"kind": "idea", "content": "идея Анны"})
check("заметки не пересекаются",
      [m["content"] for m in server.list_memories(AID)] == ["идея Анны"])
check("действия не пересекаются", server.list_actions(AID) == [])
check("контекст для модели строится по своему аккаунту",
      "заметка владельца" not in server.memory_context(AID))
check("чужое действие нельзя закрыть",
      raises(server.complete_action, AID, server.list_actions(UID)[0]["id"]))

server.save_profile(AID, {"name": "Анна Иванова", "focus": "финансы"})
check("профиль второго аккаунта сохраняется отдельно",
      server.get_profile(AID)["name"] == "Анна Иванова"
      and server.get_profile(UID)["name"] == server.DEFAULT_DIRECTOR_NAME)

# Один и тот же каталожный ключ должен уживаться у двух владельцев.
check("ключ каталога включает владельца",
      server.catalog_source_key(UID, "Лидерство", "Друкер")
      != server.catalog_source_key(AID, "Лидерство", "Друкер"))
stamp = server.now_iso()
with server.db() as conn:
    for owner in (UID, AID):
        conn.execute(
            """INSERT INTO development_books (id, user_id, source_key, title, author, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (str(__import__("uuid").uuid4()), owner, server.catalog_source_key(owner, "Лидерство", "Друкер"),
             "Лидерство", "Друкер", stamp, stamp),
        )
check("одна книга живёт в каталогах обоих аккаунтов",
      len(server.development_library(UID)["books"]) == 1
      and len(server.development_library(AID)["books"]) == 1)

deleted_files = [Path(b["stored_path"]) for b in [{"stored_path": str(anna_book)}]]
server.delete_user(AID, UID)
check("аккаунт удалён", server.find_user("anna") is None)
check("книги удалённого аккаунта исчезли",
      not any(b["id"] == "a1" for b in server.list_books(UID)))
check("файл книги удалённого аккаунта стёрт с диска", not deleted_files[0].exists())
with server.db() as conn:
    left = conn.execute("SELECT COUNT(*) c FROM chunks WHERE book_id = 'a1'").fetchone()["c"]
    orphans = conn.execute("SELECT COUNT(*) c FROM memories WHERE user_id = ?", (AID,)).fetchone()["c"]
    profiles = conn.execute("SELECT COUNT(*) c FROM director_profile WHERE user_id = ?", (AID,)).fetchone()["c"]
check("фрагменты удалённого аккаунта убраны каскадом", left == 0, f"({left})")
check("заметки удалённого аккаунта убраны", orphans == 0)
check("профиль удалённого аккаунта убран каскадом", profiles == 0, f"({profiles})")
check("данные владельца не пострадали", len(server.list_memories(UID)) == 1)

print("\n=== 15. Регистрация, почта и восстановление пароля ===")
server._mail_log.clear()
check("SMTP не настроен в тестах", not server.mail_configured())
res = server.register_user({"email": "Boris@Example.COM", "password": "ПарольБориса-2026", "display_name": "Борис"})
check("регистрация принята", res["registered"] and res["mail_configured"] is False, f"({res})")
boris = server.find_user_by_email("boris@example.com")
check("аккаунт создан с приведённым к нижнему регистру адресом", boris and boris["email"] == "boris@example.com")
check("логин выведен из адреса", boris["username"] == "boris", f"({boris['username']})")
check("новый аккаунт не администратор", not boris["is_admin"])
check("адрес ещё не подтверждён", not boris["email_verified_at"])
check("анкета ещё не пройдена", not server.onboarding_state(boris["id"])["completed"])
check("вход по адресу почты находит аккаунт", server.find_user_by_login("BORIS@example.com")["id"] == boris["id"])
check("вход по логину тоже работает", server.find_user_by_login("boris")["id"] == boris["id"])

repeat = server.register_user({"email": "boris@example.com", "password": "Совершенно-Другой"})
check("повторная регистрация отвечает так же, не раскрывая аккаунт", repeat["registered"] is True)
with server.db() as conn:
    same = conn.execute("SELECT COUNT(*) c FROM users WHERE email = 'boris@example.com'").fetchone()["c"]
check("второй аккаунт на тот же адрес не создан", same == 1)
check("пароль первого аккаунта не перезаписан",
      server.verify_password("ПарольБориса-2026", *[server.find_user_by_email("boris@example.com")[key]
                                                    for key in ("password_hash", "password_salt")]))
for bad in ("нет-собаки", "a@b", "@example.com", "спам@пример.рф ", "a" * 70 + "@example.com"):
    check(f"некорректный адрес {bad!r} отклоняется", raises(server.register_user, {"email": bad, "password": "ДлинныйПароль-2026"}))
check("короткий пароль при регистрации отклоняется",
      raises(server.register_user, {"email": "new@example.com", "password": "123"}))

letters = server.recent_mail()
check("письмо подтверждения попало в журнал", any("подтвердите" in m["subject"] for m in letters), f"({[m['subject'] for m in letters]})")
verify_link = [m for m in letters if "подтвердите" in m["subject"]][0]["body"]
verify_token = verify_link.split("token=")[1].split()[0]
check("ссылка ведёт на /verify", "/verify?token=" in verify_link)
check("подтверждение адреса срабатывает", server.verify_email_token(verify_token)["verified"])
check("адрес отмечен подтверждённым", bool(server.find_user_by_email("boris@example.com")["email_verified_at"]))
check("повторное использование ссылки отклоняется", raises(server.verify_email_token, verify_token))
check("выдуманная ссылка отклоняется", raises(server.verify_email_token, "нет-такого-токена"))

server._mail_log.clear()
check("запрос сброса для чужого адреса отвечает успехом",
      server.request_password_reset("никого@example.com")["requested"])
check("для несуществующего адреса письмо не уходит", not server.recent_mail())
server.request_password_reset("boris@example.com")
reset_body = [m for m in server.recent_mail() if "восстановление" in m["subject"]][0]["body"]
reset_token = reset_body.split("token=")[1].split()[0]
check("ссылка сброса ведёт на /reset", "/reset?token=" in reset_body)
check("короткий новый пароль отклоняется", raises(server.reset_password_with_token, reset_token, "123"))
check("после отказа ссылка ещё жива", server.reset_password_with_token(reset_token, "Пароль-После-Сброса-2026")["reset"])
boris = server.find_user_by_email("boris@example.com")
check("новый пароль работает", server.verify_password("Пароль-После-Сброса-2026", boris["password_hash"], boris["password_salt"]))
check("старый пароль больше не работает", not server.verify_password("ПарольБориса-2026", boris["password_hash"], boris["password_salt"]))
check("ссылка сброса одноразовая", raises(server.reset_password_with_token, reset_token, "Ещё-Один-Пароль-2026"))
check("выдача новой ссылки гасит предыдущую",
      (lambda first, second: server.consume_auth_token(first, "reset_password") is None
       and server.consume_auth_token(second, "reset_password") == boris["id"])(
          server.create_auth_token(boris["id"], "reset_password", 2),
          server.create_auth_token(boris["id"], "reset_password", 2)))
expired = server.create_auth_token(boris["id"], "reset_password", -1)
check("истёкшая ссылка не срабатывает", server.consume_auth_token(expired, "reset_password") is None)
check("токен хранится только хешем",
      (lambda token: (server.create_auth_token(boris["id"], "verify_email", 1),
                      not any(token in str(row) for row in _all_token_rows()))[1])("нет"))

print("\n=== 16. Анкета обучения ===")
BID = boris["id"]
profile = server.get_learning_profile(BID)
check("у нового аккаунта профиль обучения создан", profile["daily_minutes"] == 20 and profile["level"] == "beginner")
check("персонализация включена по умолчанию", profile["personalization"] is True)
catalogue = server.list_interests()
check("справочник интересов заполнен", len(catalogue) == len(server.DEFAULT_INTERESTS), f"({len(catalogue)})")
picked = [item["id"] for item in catalogue[:4]]
saved = server.save_onboarding(BID, {
    "level": "advanced", "daily_minutes": 45, "target_date": "2026-12-01", "format": "flashcards",
    "personalization": False, "interests": picked + ["выдуманный-id"],
    "goals": [{"title": "Собрать стратегию"}, {"title": ""}, "Нанять COO"],
    "books_read": ["Атомные привычки — Джеймс Клир", "  "],
    "books_wanted": [{"title": "Good Strategy Bad Strategy", "author": "Румельт"}],
})
check("анкета отмечена пройденной", saved["completed"] is True)
check("уровень и темп сохранены", saved["level"] == "advanced" and saved["daily_minutes"] == 45)
check("несуществующий интерес отброшен", len(saved["interests"]) == 4, f"({len(saved['interests'])})")
check("пустые цели отброшены", len(saved["goals"]) == 2, f"({[g['title'] for g in saved['goals']]})")
check("строка тоже принимается как цель", any(g["title"] == "Нанять COO" for g in saved["goals"]))
check("книга разобрана на название и автора",
      saved["books_read"][0]["title"] == "Атомные привычки" and saved["books_read"][0]["author"] == "Джеймс Клир",
      f"({saved['books_read']})")
check("несохранённые книги не попали", len(saved["books_read"]) == 1)
check("отказ от персонализации сохранён", saved["personalization"] is False)
check("некорректный уровень отклоняется", raises(server.save_onboarding, BID, {"level": "бог"}))
check("некорректный формат отклоняется", raises(server.save_onboarding, BID, {"format": "телепатия"}))
check("нулевое время отклоняется", raises(server.save_onboarding, BID, {"daily_minutes": 0}))
check("сутки занятий отклоняются", raises(server.save_onboarding, BID, {"daily_minutes": 2000}))
check("несуществующая дата отклоняется", raises(server.save_onboarding, BID, {"target_date": "2026-02-31"}))
check("кривой формат даты отклоняется", raises(server.save_onboarding, BID, {"target_date": "01.12.2026"}))
again = server.save_onboarding(BID, {"level": "beginner", "daily_minutes": 15, "interests": [], "goals": []})
check("повторное сохранение чистит прежние ответы", again["interests"] == [] and again["goals"] == [])
check("отметка о пройденной анкете не сбрасывается", again["completed"] is True)
check("анкеты аккаунтов не пересекаются", server.get_learning_profile(UID)["daily_minutes"] == 20)

print("\n=== 17. Экспорт и удаление своего аккаунта ===")
server.save_memory(BID, {"kind": "idea", "content": "личная идея Бориса"})
dump = server.export_user_data(BID)
check("экспорт содержит аккаунт и профиль обучения", dump["account"]["username"] == "boris" and dump["learning_profile"])
check("экспорт содержит заметки", any("Бориса" in m["content"] for m in dump["memories"]))
check("в экспорте нет пароля", "password_hash" not in json.dumps(dump) and "password_salt" not in json.dumps(dump))
check("чужих заметок в экспорте нет", all("владельца" not in m["content"] for m in dump["memories"]))
check("удаление с неверным паролем отклоняется", raises(server.delete_own_account, BID, "не тот"))
check("аккаунт на месте", server.find_user_by_email("boris@example.com") is not None)
check("удаление своего аккаунта работает", server.delete_own_account(BID, "Пароль-После-Сброса-2026")["deleted"])
check("аккаунт исчез", server.find_user_by_email("boris@example.com") is None)
with server.db() as conn:
    left_profile = conn.execute("SELECT COUNT(*) c FROM learning_profiles WHERE user_id = ?", (BID,)).fetchone()["c"]
    left_tokens = conn.execute("SELECT COUNT(*) c FROM auth_tokens WHERE user_id = ?", (BID,)).fetchone()["c"]
    left_goals = conn.execute("SELECT COUNT(*) c FROM goals WHERE user_id = ?", (BID,)).fetchone()["c"]
check("профиль обучения удалён каскадом", left_profile == 0)
check("ссылки подтверждения удалены каскадом", left_tokens == 0)
check("цели удалены каскадом", left_goals == 0)
check("единственный администратор не может удалить себя",
      raises(server.delete_own_account, UID, "МойСложныйПароль-2026"))

print("\n=== 18. Ограничение частоты и лимиты запросов ===")
server.rate_limiter.reset()
saved_limits = dict(server.RATE_LIMITS)
server.RATE_LIMITS["answer"] = (3, 3600.0)
try:
    for _ in range(3):
        server.rate_limiter.check("answer", "клиент-1")
    check("в пределах квоты запросы проходят", True)
    check("превышение квоты -> ClientError", raises(server.rate_limiter.check, "answer", "клиент-1"))
    try:
        server.rate_limiter.check("answer", "клиент-1")
    except server.ClientError as e:
        check("в ошибке указано время ожидания", "Повторите через" in str(e), f"({e})")
    server.rate_limiter.check("answer", "клиент-2")
    check("другой клиент не затронут", True)
finally:
    server.RATE_LIMITS.clear()
    server.RATE_LIMITS.update(saved_limits)
    server.rate_limiter.reset()

check("длинный вопрос отклоняется",
      raises(server.bounded_text, "я" * (server.MAX_QUESTION_CHARS + 1), server.MAX_QUESTION_CHARS, "Вопрос"))
check("вопрос в пределах лимита проходит",
      server.bounded_text("  вопрос  ", server.MAX_QUESTION_CHARS, "Вопрос") == "вопрос")
check("слишком много книг за раз отклоняется",
      raises(server.selected_book_ids, {"book_ids": [str(i) for i in range(server.MAX_SELECTED_BOOKS + 1)]}))
check("книги списком обязательны", raises(server.selected_book_ids, {"book_ids": "не список"}))
check("пустые идентификаторы отбрасываются",
      server.selected_book_ids({"book_ids": ["a", "  ", "b"]}) == ["a", "b"])
check("одиночный book_id поддерживается", server.selected_book_ids({"book_id": "x"}) == ["x"])

print("\n=== 19. Проверка конфигурации при старте ===")
saved_auth, saved_host = server.AUTH_REQUIRED, server.HOST
try:
    server.AUTH_REQUIRED = False
    server.HOST = "0.0.0.0"
    try:
        server.guard_startup_configuration()
        check("анонимный режим на публичном адресе запрещён", False, "(сервер согласился стартовать)")
    except SystemExit as e:
        check("анонимный режим на публичном адресе запрещён", "loopback" in str(e), f"({e})")
    server.HOST = "127.0.0.1"
    server.guard_startup_configuration()
    check("анонимный режим на localhost разрешён", True)
    server.AUTH_REQUIRED = True
    saved_secret = server.SESSION_SECRET
    server.SESSION_SECRET = "короткий"
    try:
        server.guard_startup_configuration()
        check("короткий секрет сессии отклоняется", False, "(сервер согласился стартовать)")
    except SystemExit:
        check("короткий секрет сессии отклоняется", True)
    server.SESSION_SECRET = saved_secret
finally:
    server.AUTH_REQUIRED, server.HOST = saved_auth, saved_host

print("\n=== 20. Резервное копирование ===")
copy_path = server.backup_database(WORK / "backup-test.db")
check("файл резервной копии создан", copy_path.exists() and copy_path.stat().st_size > 0)
import sqlite3 as _sqlite3
_backup = _sqlite3.connect(copy_path)
try:
    users_in_copy = _backup.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    books_in_copy = _backup.execute("SELECT COUNT(*) FROM books").fetchone()[0]
finally:
    _backup.close()
with server.db() as conn:
    users_live = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    books_live = conn.execute("SELECT COUNT(*) c FROM books").fetchone()["c"]
check("копия содержит те же аккаунты", users_in_copy == users_live, f"({users_in_copy} vs {users_live})")
check("копия содержит те же книги", books_in_copy == books_live, f"({books_in_copy} vs {books_live})")

print("\n" + "=" * 54)
print(f"ИТОГО: {OK} пройдено, {FAIL} провалено")
if FAILURES:
    print("Провалено:", "; ".join(FAILURES))
sys.exit(1 if FAIL else 0)
