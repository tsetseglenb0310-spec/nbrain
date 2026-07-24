const $ = (selector) => document.querySelector(selector);
const bookList = $('#book-list');
const bookFilter = $('#book-filter');
const analysisMode = $('#analysis-mode');
const responseDetail = $('#response-detail');
const answerProvider = $('#answer-provider');
const uploadStatus = $('#upload-status');
const questionStatus = $('#question-status');
const answerPanel = $('#answer-panel');
const answerText = $('#answer-text');
const sourceList = $('#source-list');
const profileStatus = $('#profile-status');
const actionList = $('#action-list');
const memoryList = $('#memory-list');
const actionStatus = $('#action-status');
const answerMemoryStatus = $('#answer-memory-status');
const exportActions = $('#export-actions');
const authGate = $('#auth-gate');
const loginStatus = $('#login-status');
let latestAnswer = '';
let latestQuestion = '';
let latestSources = [];
let latestMode = 'reader';

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function formatPages(source) {
  return source.page_from === source.page_to ? `стр. ${source.page_from}` : `стр. ${source.page_from}–${source.page_to}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) showAuthGate();
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  return payload;
}

function showAuthGate() {
  authGate.classList.remove('hidden');
  $('#login-password').focus();
}

function hideAuthGate() {
  authGate.classList.add('hidden');
  setStatus(loginStatus, '');
}

function setupWorkspaceNavigation() {
  const links = Array.from(document.querySelectorAll('[data-section-link]'));
  const panels = Array.from(document.querySelectorAll('[data-workspace-panel]'));
  const availableIds = new Set(panels.map((panel) => panel.dataset.workspacePanel));
  const showSection = (id, writeHash = true) => {
    if (!availableIds.has(id)) return;
    panels.forEach((panel) => {
      panel.classList.toggle('workspace-hidden', panel.dataset.workspacePanel !== id);
    });
    document.querySelectorAll('.workspace-nav [data-section-link]').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.sectionLink === id);
    });
    if (id === 'profile-section') $('#profile-section').open = true;
    if (writeHash && window.location.hash !== `#${id}`) {
      window.history.replaceState(null, '', `#${id}`);
    }
  };
  links.forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    showSection(link.dataset.sectionLink);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  const requestedId = window.location.hash.slice(1);
  showSection(availableIds.has(requestedId) ? requestedId : 'analysis-section', false);
}

async function initializeApp() {
  try {
    const status = await api('/api/auth/status');
    if (status.auth_required && !status.authenticated) {
      showAuthGate();
      return;
    }
    hideAuthGate();
    await Promise.all([loadProfile(), loadBooks(), loadActions(), loadMemories()]);
    await loadDevelopmentLibrary();
  } catch (error) {
    showAuthGate();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-button');
  button.disabled = true;
  setStatus(loginStatus, 'Проверяю пароль…');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить вход.');
    $('#login-password').value = '';
    hideAuthGate();
    await Promise.all([loadProfile(), loadBooks(), loadActions(), loadMemories()]);
    await loadDevelopmentLibrary();
  } catch (error) {
    setStatus(loginStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

function renderBooks(books) {
  bookFilter.innerHTML = '';
  if (!books.length) {
    bookList.innerHTML = '<p class="empty-state">Книги пока не загружены.</p>';
    return;
  }
  bookList.innerHTML = books.map((book) => {
    const detail = book.status === 'ready'
      ? `${book.page_count} стр. · ${book.chunk_count} фрагментов`
      : book.error || 'Индексируется…';
    return `<article class="book-row"><div><strong>${escapeHtml(displayBookTitle(book.title))}</strong><span>${escapeHtml(detail)}</span></div><span class="book-status ${escapeHtml(book.status)}">${book.status === 'ready' ? 'Готово' : 'Обработка'}</span></article>`;
  }).join('');
  for (const book of books.filter((book) => book.status === 'ready')) {
    const label = document.createElement('label');
    label.className = 'book-choice';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(book.id)}" /><span>${escapeHtml(displayBookTitle(book.title))}</span><small>${book.page_count} стр.</small>`;
    bookFilter.append(label);
  }
}

function displayBookTitle(title) {
  return String(title)
    .replace(/^OceanofPDF\.com\s*/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/[-_][a-f0-9]{8,}$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function selectedBookIds() {
  return Array.from(bookFilter.querySelectorAll('input:checked')).map((input) => input.value);
}

$('#select-all-books').addEventListener('click', () => {
  Array.from(bookFilter.querySelectorAll('input')).forEach((input) => { input.checked = true; });
});

$('#clear-book-selection').addEventListener('click', () => {
  Array.from(bookFilter.querySelectorAll('input')).forEach((input) => { input.checked = false; });
});

async function loadBooks() {
  try {
    const { books } = await api('/api/books');
    renderBooks(books);
  } catch (error) {
    bookList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
  }
}

const developmentStatusLabels = {
  planned: 'Планирую',
  reading: 'Читаю',
  read: 'Прочитал',
  implemented: 'Внедряю',
};
let developmentSearchTimer;

function optionHtml(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function renderDevelopmentSelects(filters) {
  const strengthSelect = $('#development-strength');
  const stageSelect = $('#development-stage');
  const selectedStrength = strengthSelect.value;
  const selectedStage = stageSelect.value;
  strengthSelect.innerHTML = '<option value="">Все таланты</option>'
    + (filters.strengths || []).map((strength) => optionHtml(strength, strength)).join('');
  stageSelect.innerHTML = '<option value="">Все этапы</option>'
    + (filters.stages || []).map((stage) => optionHtml(stage, `Этап ${stage}`)).join('');
  strengthSelect.value = (filters.strengths || []).includes(selectedStrength) ? selectedStrength : '';
  stageSelect.value = (filters.stages || []).includes(selectedStage) ? selectedStage : '';
}

function renderDevelopmentStats(summary) {
  const statItems = [
    ['В библиотеке', summary.total || 0],
    ['Must Read', summary.must_read || 0],
    ['Этап 1', summary.stage_1 || 0],
    ['Читаю сейчас', summary.reading || 0],
    ['Внедряю', summary.implemented || 0],
  ];
  $('#development-stats').innerHTML = statItems.map(([label, value]) => (
    `<div class="development-stat"><strong>${value}</strong><span>${label}</span></div>`
  )).join('');
}

function catalogBadges(book) {
  const badges = [];
  if (book.must_read) badges.push('<span class="catalog-badge must-read">Must Read</span>');
  if (book.reading_stage) badges.push(`<span class="catalog-badge">Этап ${escapeHtml(book.reading_stage)}</span>`);
  if (book.strength) badges.push(`<span class="catalog-badge strength-badge">${escapeHtml(book.strength)}</span>`);
  return badges.join('');
}

function catalogStatusOptions(currentStatus) {
  return Object.entries(developmentStatusLabels).map(([value, label]) => (
    `<option value="${value}" ${currentStatus === value ? 'selected' : ''}>${label}</option>`
  )).join('');
}

function renderDevelopmentCatalog(books, total) {
  $('#development-count').textContent = total ? `${books.length} из ${total}` : '';
  if (!books.length) {
    $('#development-library-list').innerHTML = '<p class="empty-state">По этому фильтру книг не найдено.</p>';
    return;
  }
  $('#development-library-list').innerHTML = books.map((book) => `
    <article class="development-book">
      <div class="development-book-topline">
        <div><h4>${escapeHtml(book.title)}</h4><p>${escapeHtml([book.author, book.category].filter(Boolean).join(' · '))}</p></div>
        <select class="catalog-status" data-development-id="${escapeHtml(book.id)}" aria-label="Статус чтения ${escapeHtml(book.title)}">${catalogStatusOptions(book.reading_status)}</select>
      </div>
      <div class="catalog-badges">${catalogBadges(book)}</div>
      <p class="development-description">${escapeHtml(book.fit_reason || book.description || 'Рекомендация из личной программы развития.')}</p>
      <div class="catalog-source ${book.has_uploaded_source ? 'ready' : ''}">${book.has_uploaded_source ? 'Текст загружен в RAG: можно задавать вопросы с источниками.' : 'Текст книги ещё не загружен: каталог помогает выбрать книгу, а RAG — изучать её содержание.'}</div>
    </article>
  `).join('');
}

function renderDevelopmentRecommendations(recommendations) {
  if (!recommendations.length) {
    $('#development-recommendations').innerHTML = '<p class="empty-state">Импортируйте Excel-библиотеку, чтобы увидеть персональный маршрут чтения.</p>';
    return;
  }
  $('#development-recommendations').innerHTML = recommendations.map((book, index) => `
    <article class="recommendation-card">
      <span class="recommendation-number">${index + 1}</span>
      <div>
        <h4>${escapeHtml(book.title)}</h4>
        <p class="recommendation-meta">${escapeHtml([book.author, book.strength, book.reading_stage ? `этап ${book.reading_stage}` : ''].filter(Boolean).join(' · '))}</p>
        <p>${escapeHtml(book.recommendation_reason || book.fit_reason || book.description || '')}</p>
        <div class="catalog-badges">${catalogBadges(book)}</div>
      </div>
    </article>
  `).join('');
}

function developmentQuery() {
  const parameters = new URLSearchParams();
  const search = $('#development-search').value.trim();
  if (search) parameters.set('q', search);
  if ($('#development-strength').value) parameters.set('strength', $('#development-strength').value);
  if ($('#development-stage').value) parameters.set('stage', $('#development-stage').value);
  if ($('#development-status').value) parameters.set('status', $('#development-status').value);
  if ($('#development-must-read').checked) parameters.set('must_read', 'true');
  return parameters.toString();
}

async function loadDevelopmentLibrary() {
  const list = $('#development-library-list');
  try {
    const query = developmentQuery();
    const [library, recommendationResponse] = await Promise.all([
      api(`/api/development-library${query ? `?${query}` : ''}`),
      api('/api/development-library/recommendations'),
    ]);
    renderDevelopmentSelects(library.filters || {});
    renderDevelopmentStats(library.summary || {});
    renderDevelopmentCatalog(library.books || [], (library.summary || {}).total || 0);
    renderDevelopmentRecommendations(recommendationResponse.recommendations || []);
  } catch (error) {
    list.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
  }
}

$('#development-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#development-library-file');
  const file = input.files[0];
  if (!file) {
    setStatus($('#development-import-status'), 'Выберите файл Excel с библиотекой.', true);
    return;
  }
  const button = $('#development-import-button');
  button.disabled = true;
  setStatus($('#development-import-status'), `Импортирую «${file.name}»…`);
  try {
    const result = await api('/api/development-library/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    input.value = '';
    setStatus($('#development-import-status'), `Готово: импортировано книг — ${result.books}, ресурсов — ${result.resources}.`);
    await loadDevelopmentLibrary();
  } catch (error) {
    setStatus($('#development-import-status'), error.message, true);
  } finally {
    button.disabled = false;
  }
});

['development-strength', 'development-stage', 'development-status', 'development-must-read'].forEach((id) => {
  $("#" + id).addEventListener('change', loadDevelopmentLibrary);
});

$('#development-search').addEventListener('input', () => {
  window.clearTimeout(developmentSearchTimer);
  developmentSearchTimer = window.setTimeout(loadDevelopmentLibrary, 250);
});

$('#development-library-list').addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-development-id]');
  if (!select) return;
  select.disabled = true;
  try {
    await api('/api/development-library/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: select.dataset.developmentId, reading_status: select.value }),
    });
    await loadDevelopmentLibrary();
  } catch (error) {
    setStatus($('#development-import-status'), error.message, true);
  } finally {
    select.disabled = false;
  }
});

function strengthsToText(strengths) {
  return Array.isArray(strengths) ? strengths.join(', ') : '';
}

async function loadProfile() {
  try {
    const { profile } = await api('/api/profile');
    $('#director-name').value = profile.name || '';
    $('#director-strengths').value = strengthsToText(profile.strengths);
    $('#director-goals').value = profile.goals || '';
    $('#director-focus').value = profile.focus || '';
    $('#focus-summary').textContent = profile.focus || 'Укажите фокус в профиле, чтобы получать персональные рекомендации.';
  } catch (error) {
    setStatus(profileStatus, error.message, true);
  }
}

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#profile-save');
  button.disabled = true;
  setStatus(profileStatus, 'Сохраняю профиль…');
  const strengths = $('#director-strengths').value.split(',').map((item) => item.trim()).filter(Boolean);
  try {
    const { profile } = await api('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#director-name').value,
        strengths,
        goals: $('#director-goals').value,
        focus: $('#director-focus').value,
      }),
    });
    $('#director-strengths').value = strengthsToText(profile.strengths);
    $('#focus-summary').textContent = profile.focus || 'Укажите фокус в профиле, чтобы получать персональные рекомендации.';
    setStatus(profileStatus, 'Профиль сохранён. Следующие ответы будут учитывать этот контекст.');
    await loadDevelopmentLibrary();
  } catch (error) {
    setStatus(profileStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

const modeDescriptions = {
  reader: 'Reader: выберите книгу для точного ответа или не выбирайте ничего для поиска по всей библиотеке.',
  thinker: 'Thinker: выберите минимум две книги — NBrain сравнит идеи, различия и общий вывод.',
  strategist: 'Strategist: выберите одну или несколько книг, чтобы создать план на 90 дней и скачать его в Word/PDF.',
};

function updateResponseFormat() {
  const isReader = analysisMode.value === 'reader';
  responseDetail.disabled = !isReader;
  if (!isReader) responseDetail.value = 'standard';
  $('#detail-help').textContent = isReader
    ? 'Для подробного разбора выберите одну проиндексированную книгу. NBrain проанализирует её идеи, логику и практическое применение с источниками.'
    : 'Подробный разбор доступен в режиме Reader. Для Thinker и Strategist NBrain использует их специализированную структуру ответа.';
}

analysisMode.addEventListener('change', () => {
  $('#books-help').textContent = modeDescriptions[analysisMode.value];
  updateResponseFormat();
});

document.querySelectorAll('.prompt-chips button').forEach((button) => {
  button.addEventListener('click', () => {
    $('#question').value = button.dataset.prompt;
    if (button.dataset.prompt.includes('90 дней')) analysisMode.value = 'strategist';
    if (button.dataset.detail) {
      analysisMode.value = 'reader';
      responseDetail.value = button.dataset.detail;
    }
    $('#books-help').textContent = modeDescriptions[analysisMode.value];
    updateResponseFormat();
    $('#question').focus();
  });
});

function renderSources(sources) {
  sourceList.innerHTML = sources.map((source, index) => `
    <article id="source-${index + 1}" class="source-card">
      <div class="source-topline"><strong>[S${index + 1}] ${escapeHtml(source.title)}</strong><span>${formatPages(source)}</span></div>
      <p>${escapeHtml(source.content)}</p>
      <small>${source.source_kind === 'overview' ? 'Фрагмент для целостного охвата книги' : `Релевантность: ${Math.round(source.score * 100)}%`}</small>
    </article>
  `).join('');
}

function renderInlineAnswer(text, sourceCount) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[S(\d+)\]/g, (match, number) => (
      Number(number) <= sourceCount
        ? `<button class="citation-link" type="button" data-source="${number}" aria-label="Открыть источник S${number}">[S${number}]</button>`
        : match
    ));
}

function renderAnswer(answer, sourceCount) {
  return escapeHtml(answer)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${renderInlineAnswer(paragraph, sourceCount).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderResult(answer, sources, generated = true) {
  latestAnswer = answer;
  latestQuestion = $('#question').value.trim();
  latestSources = sources;
  latestMode = analysisMode.value;
  answerPanel.classList.remove('hidden');
  answerText.innerHTML = renderAnswer(answer, sources.length);
  renderSources(sources);
  exportActions.classList.toggle('hidden', !generated || latestMode !== 'strategist');
  answerPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatDueDate(value) {
  if (!value) return 'без срока';
  const [year, month, day] = value.split('-');
  return `до ${day}.${month}.${year}`;
}

function renderActions(actions) {
  if (!actions.length) {
    actionList.innerHTML = '<p class="empty-state">Действий пока нет.</p>';
    return;
  }
  actionList.innerHTML = actions.map((action) => `
    <article class="action-row ${escapeHtml(action.status)}">
      <div><strong>${escapeHtml(action.title)}</strong><span>${escapeHtml(action.details || 'Без дополнительного описания')} · ${formatDueDate(action.due_date)}</span></div>
      ${action.status === 'open' ? `<button class="button-secondary action-complete" data-action-id="${escapeHtml(action.id)}" type="button">Готово</button>` : '<span class="done-label">Выполнено</span>'}
    </article>
  `).join('');
}

function shorten(value, length = 360) {
  return value.length > length ? `${value.slice(0, length).trim()}…` : value;
}

function renderMemories(memories) {
  if (!memories.length) {
    memoryList.innerHTML = '<p class="empty-state">Сохранённых идей пока нет.</p>';
    return;
  }
  memoryList.innerHTML = memories.map((memory) => `
    <article class="memory-row"><strong>${memory.kind === 'decision' ? 'Решение' : memory.kind === 'note' ? 'Заметка' : 'Идея'}</strong><p>${escapeHtml(shorten(memory.content))}</p></article>
  `).join('');
}

async function loadActions() {
  try {
    const { actions } = await api('/api/actions');
    renderActions(actions);
  } catch (error) {
    actionList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadMemories() {
  try {
    const { memories } = await api('/api/memories');
    renderMemories(memories);
  } catch (error) {
    memoryList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
  }
}

async function saveAction(payload, statusElement = actionStatus) {
  const { action } = await api('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  setStatus(statusElement, `Действие «${action.title}» сохранено.`);
  await loadActions();
}

$('#action-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#action-save');
  button.disabled = true;
  setStatus(actionStatus, 'Сохраняю действие…');
  try {
    await saveAction({ title: $('#action-title').value, details: $('#action-details').value, due_date: $('#action-date').value });
    $('#action-form').reset();
  } catch (error) {
    setStatus(actionStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

actionList.addEventListener('click', async (event) => {
  const button = event.target.closest('.action-complete');
  if (!button) return;
  button.disabled = true;
  try {
    await api('/api/actions/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: button.dataset.actionId }) });
    setStatus(actionStatus, 'Действие отмечено как выполненное.');
    await loadActions();
  } catch (error) {
    setStatus(actionStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#save-idea').addEventListener('click', async () => {
  if (!latestAnswer) return;
  const button = $('#save-idea');
  button.disabled = true;
  setStatus(answerMemoryStatus, 'Сохраняю идею…');
  try {
    await api('/api/memories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'idea', content: `Вопрос: ${latestQuestion}\n\nОтвет NBrain:\n${latestAnswer}` }),
    });
    setStatus(answerMemoryStatus, 'Идея сохранена в памяти NBrain.');
    await loadMemories();
  } catch (error) {
    setStatus(answerMemoryStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#answer-to-action').addEventListener('click', async () => {
  if (!latestAnswer) return;
  const title = window.prompt('Какое конкретное действие создать?');
  if (!title || !title.trim()) return;
  const button = $('#answer-to-action');
  button.disabled = true;
  setStatus(answerMemoryStatus, 'Создаю действие…');
  try {
    await saveAction({ title, details: `Создано из ответа NBrain на вопрос: ${latestQuestion}\n\n${latestAnswer}` }, answerMemoryStatus);
  } catch (error) {
    setStatus(answerMemoryStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function exportPlan(format) {
  if (latestMode !== 'strategist' || !latestAnswer) return;
  const button = format === 'docx' ? $('#export-docx') : $('#export-pdf');
  button.disabled = true;
  setStatus(answerMemoryStatus, `Готовлю ${format === 'docx' ? 'Word' : 'PDF'}…`);
  try {
    const response = await fetch(`/api/export/${format}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: latestQuestion, answer: latestAnswer, sources: latestSources }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Не удалось создать файл.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = format === 'docx' ? 'NBrain_Strategy_Plan.docx' : 'NBrain_Strategy_Plan.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    setStatus(answerMemoryStatus, 'Файл сформирован и скачан.');
  } catch (error) {
    setStatus(answerMemoryStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('#export-docx').addEventListener('click', () => exportPlan('docx'));
$('#export-pdf').addEventListener('click', () => exportPlan('pdf'));

answerText.addEventListener('click', (event) => {
  const link = event.target.closest('.citation-link');
  if (!link) return;
  const source = document.querySelector(`#source-${link.dataset.source}`);
  if (!source) return;
  source.scrollIntoView({ behavior: 'smooth', block: 'center' });
  source.classList.remove('source-highlight');
  window.setTimeout(() => source.classList.add('source-highlight'), 20);
});

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#book-file');
  const file = input.files[0];
  if (!file) return;
  const button = $('#upload-button');
  button.disabled = true;
  setStatus(uploadStatus, `Индексирую «${file.name}»…`);
  try {
    const data = await api('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    setStatus(uploadStatus, `Готово: ${data.pages} стр., ${data.chunks} фрагментов.`);
    input.value = '';
    await loadBooks();
  } catch (error) {
    setStatus(uploadStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function findOrAnswer(withAnswer) {
  const question = $('#question').value.trim();
  if (!question) return;
  const bookIds = selectedBookIds();
  const mode = analysisMode.value;
  const detail = responseDetail.value;
  const provider = answerProvider.value;
  if (withAnswer && mode === 'thinker' && bookIds.length < 2) {
    setStatus(questionStatus, 'Для режима Thinker выберите минимум две книги.', true);
    return;
  }
  if (withAnswer && detail === 'deep' && mode === 'reader' && bookIds.length !== 1) {
    setStatus(questionStatus, 'Для подробного разбора выберите ровно одну проиндексированную книгу.', true);
    return;
  }
  const button = withAnswer ? $('#answer-button') : $('#search-button');
  button.disabled = true;
  setStatus(questionStatus, withAnswer ? 'NBrain ищет источники и готовит ответ…' : 'NBrain ищет релевантные фрагменты…');
  try {
    if (withAnswer) {
      const data = await api('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, book_ids: bookIds, mode, detail, provider }) });
      renderResult(data.answer, data.sources);
      $('#answer-title').textContent = detail === 'deep' && mode === 'reader' ? 'Подробный разбор книги' : mode === 'thinker' ? 'Синтез NBrain' : mode === 'strategist' ? 'Стратегический план' : 'Рекомендация';
      setStatus(questionStatus, `Найдено ${data.sources.length} источников.`);
    } else {
      const data = await api('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: question, book_ids: bookIds, limit: 8 }) });
      renderResult('Ниже — наиболее релевантные фрагменты. Нажмите «Получить ответ», чтобы NBrain сделал вывод по ним.', data.results, false);
      setStatus(questionStatus, `Найдено ${data.results.length} фрагментов.`);
    }
  } catch (error) {
    setStatus(questionStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('#question-form').addEventListener('submit', (event) => { event.preventDefault(); findOrAnswer(true); });
$('#search-button').addEventListener('click', () => findOrAnswer(false));
$('#refresh-books').addEventListener('click', loadBooks);
updateResponseFormat();
setupWorkspaceNavigation();
initializeApp();
