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
const currentUserChip = $('#current-user');
const logoutButton = $('#logout-button');
const usersAdmin = $('#users-admin');
const userList = $('#user-list');
const userStatus = $('#user-status');
const passwordStatus = $('#password-status');
const verifyBanner = $('#verify-banner');
const onboardingGate = $('#onboarding-gate');
const onboardingStatus = $('#onboarding-status');
let currentUser = null;
let interestCatalogue = [];
let latestAnswer = '';
let latestQuestion = '';
let latestSources = [];
let latestMode = 'reader';

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', isError);
}

const toastHost = $('#toast-host');

// Background loads used to write their errors into the status line of the
// section they belong to. Only one section is visible at a time, so a failure
// while loading books or the profile landed in a display:none element and was
// never seen. Anything the person has to know now goes through here.
function toast(message, kind = 'info') {
  if (!message) return;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  const dismiss = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 250);
  };
  node.addEventListener('click', dismiss);
  toastHost.appendChild(node);
  setTimeout(dismiss, kind === 'error' ? 9000 : 5000);
}

function reportError(error, fallback = 'Не удалось выполнить запрос.') {
  const message = error && error.message ? error.message : fallback;
  if (message === SESSION_EXPIRED) return;
  toast(message, 'error');
}

const SESSION_EXPIRED = 'session-expired';

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function formatPages(source) {
  return source.page_from === source.page_to ? `стр. ${source.page_from}` : `стр. ${source.page_from}–${source.page_to}`;
}

const REQUEST_TIMEOUT_MS = 180000;

// Every request goes through here: JSON body, timeout, one place that notices
// an expired session. Without the timeout a hung connection left the button
// disabled and the status line stuck on "Отправляю…" forever.
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(path, { ...options, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') throw new Error('Запрос выполнялся слишком долго и был прерван.');
    throw new Error('Нет связи с сервером. Проверьте подключение и повторите.');
  }
  clearTimeout(timer);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showAuthGate();
    throw new Error(SESSION_EXPIRED);
  }
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  return payload;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The same shape repeated in ten handlers: disable, report, restore.
async function withBusy(button, statusElement, message, action) {
  if (button) button.disabled = true;
  setStatus(statusElement, message);
  try {
    const result = await action();
    setStatus(statusElement, '');
    return result;
  } catch (error) {
    if (error.message === SESSION_EXPIRED) setStatus(statusElement, '');
    else setStatus(statusElement, error.message, true);
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function showAuthGate(panel = 'login') {
  authGate.classList.remove('hidden');
  clearWorkspace();
  setCurrentUser(null);
  showAuthPanel(panel);
}

function hideAuthGate() {
  authGate.classList.add('hidden');
  setStatus(loginStatus, '');
}

const AUTH_TITLES = {
  login: ['Вход в NBrain', 'Введите логин или почту и пароль, чтобы открыть свою библиотеку.'],
  register: ['Создание аккаунта', 'Своя библиотека, свои заметки и свой учебный план. Данные других пользователей вам не видны, а ваши — им.'],
  forgot: ['Восстановление пароля', 'Укажите почту, к которой привязан аккаунт.'],
  reset: ['Новый пароль', 'Придумайте пароль, который вы ещё нигде не использовали.'],
};

function showAuthPanel(panel) {
  const known = AUTH_TITLES[panel] ? panel : 'login';
  document.querySelectorAll('[data-auth-panel]').forEach((form) => {
    form.classList.toggle('hidden', form.dataset.authPanel !== known);
  });
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    const active = tab.dataset.authTab === known;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  // Tabs only make sense between the two entry points; the recovery forms are
  // reached from a link or an e-mail and would look like a third mode.
  $('.auth-tabs').classList.toggle('hidden', known === 'reset' || known === 'forgot');
  const [title, intro] = AUTH_TITLES[known];
  $('#auth-title').textContent = title;
  $('#auth-intro').textContent = intro;
  setStatus(loginStatus, '');
  const focusTarget = $(`[data-auth-panel="${known}"]`).querySelector('input');
  if (focusTarget) focusTarget.focus();
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-auth-tab]');
  if (!tab) return;
  event.preventDefault();
  showAuthPanel(tab.dataset.authTab);
});

// Leaving an account must not leave its books, notes and actions on screen
// behind the sign-in overlay, and must not leave the status poller asking the
// server for them.
function clearWorkspace() {
  stopIndexingPoll();
  bookList.innerHTML = '<p class="empty-state">Книги пока не загружены.</p>';
  bookFilter.innerHTML = '';
  actionList.innerHTML = '<p class="empty-state">Действий пока нет.</p>';
  memoryList.innerHTML = '<p class="empty-state">Сохранённых идей пока нет.</p>';
  userList.innerHTML = '';
  answerPanel.classList.add('hidden');
  answerText.innerHTML = '';
  sourceList.innerHTML = '';
  latestAnswer = '';
  latestQuestion = '';
  latestSources = [];
  ['#director-name', '#director-focus', '#director-strengths', '#director-goals'].forEach((selector) => {
    const field = $(selector);
    if (field) field.value = '';
  });
  // The heading and the focus line carry the previous person's name and words,
  // so they have to be reset too, not just the input fields.
  $('#profile-title').textContent = 'Профиль';
  $('#focus-summary').textContent = 'Укажите фокус в профиле, чтобы получать персональные рекомендации.';
  const library = $('#development-library-list');
  if (library) library.innerHTML = '';
  const recommendations = $('#development-recommendations');
  if (recommendations) recommendations.innerHTML = '';
  ['#plan-list', '#flashcard-panel', '#lesson-body', '#reader-body', '#progress-body'].forEach((selector) => {
    const node = $(selector);
    if (node) node.innerHTML = '';
  });
  $('#lesson-view').classList.add('hidden');
  $('#learning-plans-view').classList.remove('hidden');
  readerBookId = '';
  readerOpenedAt = 0;
  currentPlan = null;
  currentLesson = null;
  cardQueue = [];
  verifyBanner.classList.add('hidden');
}

function setCurrentUser(user) {
  currentUser = user;
  const known = Boolean(user);
  currentUserChip.textContent = known ? `${user.display_name || user.username}${user.is_admin ? ' · админ' : ''}` : '';
  currentUserChip.classList.toggle('hidden', !known);
  logoutButton.classList.toggle('hidden', !known);
  usersAdmin.classList.toggle('hidden', !known || !user.is_admin);
  // Only accounts that actually have an address can confirm one; the first
  // administrator is created from environment variables and has none.
  verifyBanner.classList.toggle('hidden', !known || !user.email || user.email_verified);
}

// Every panel holds one person's data, so a switch of account has to reload
// all of them together rather than leaving the previous library on screen.
async function loadWorkspace({ firstRun = false } = {}) {
  await Promise.all([loadProfile(), loadBooks(), loadActions(), loadMemories()]);
  await loadDevelopmentLibrary();
  await Promise.all([loadPlans(), loadFlashcards(), loadProgress()]);
  if (currentUser && currentUser.is_admin) await loadUsers();
  // Someone who just finished the questionnaire has an empty library, and the
  // default section asks them to pick books they do not have. Start them where
  // the first useful action is instead.
  if (firstRun && !bookList.querySelector('.book-row') && !window.location.hash) {
    goToSection('knowledge-section');
  }
}

async function loadUsers() {
  try {
    const payload = await api('/api/users');
    renderUsers(payload.users || []);
  } catch (error) {
    setStatus(userStatus, error.message, true);
    reportError(error, 'Не удалось загрузить список аккаунтов.');
  }
}

function renderUsers(users) {
  userList.innerHTML = users.map((user) => `
    <article class="action-item">
      <div>
        <h4>${escapeHtml(user.display_name || user.username)}</h4>
        <p class="recommendation-meta">${escapeHtml(user.username)}${user.is_admin ? ' · администратор' : ''} · книг: ${Number(user.book_count) || 0}</p>
      </div>
      ${user.id === (currentUser && currentUser.id)
        ? '<span class="status">это вы</span>'
        : `<button class="button-secondary" type="button" data-delete-user="${escapeHtml(user.id)}">Удалить</button>`}
    </article>`).join('');
}

userList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-user]');
  if (!button) return;
  const card = button.closest('.action-item');
  const name = card ? card.querySelector('h4').textContent : 'этого пользователя';
  if (!window.confirm(`Удалить ${name}? Книги, заметки и действия этого аккаунта будут удалены безвозвратно.`)) return;
  button.disabled = true;
  try {
    await api('/api/users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: button.dataset.deleteUser }),
    });
    setStatus(userStatus, 'Пользователь удалён.');
    await loadUsers();
  } catch (error) {
    setStatus(userStatus, error.message, true);
    button.disabled = false;
  }
});

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(userStatus, 'Создаю аккаунт…');
  try {
    const user = await api('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#new-username').value,
        display_name: $('#new-display-name').value,
        email: $('#new-user-email').value,
        password: $('#new-user-password').value,
        is_admin: $('#new-user-admin').checked,
      }),
    });
    event.target.reset();
    setStatus(userStatus, `Аккаунт «${user.user.username}» создан.`);
    await loadUsers();
  } catch (error) {
    setStatus(userStatus, error.message, true);
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(passwordStatus, 'Меняю пароль…');
  try {
    await api('/api/users/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: $('#current-password').value,
        new_password: $('#new-password').value,
      }),
    });
    event.target.reset();
    // The server invalidated this session on purpose: the cookie is signed
    // with the old password, so the only honest next step is a fresh login.
    setStatus(passwordStatus, 'Пароль изменён. Войдите заново.');
    showAuthGate();
  } catch (error) {
    setStatus(passwordStatus, error.message, true);
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await postJson('/api/auth/logout', {});
  } catch (error) {
    // The cookie is cleared by the server; if the request never arrived the
    // local state still has to be dropped, so failure changes nothing here.
  } finally {
    showAuthGate();
  }
});

const accountDataStatus = $('#account-data-status');

$('#export-data').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setStatus(accountDataStatus, 'Собираю данные…');
  try {
    const response = await fetch('/api/account/export');
    if (response.status === 401) {
      showAuthGate();
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Не удалось выгрузить данные.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'nbrain-my-data.json';
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking straight after the click can cut off a large download in some
    // browsers, so the URL is released a moment later.
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    setStatus(accountDataStatus, 'Файл выгружен.');
  } catch (error) {
    setStatus(accountDataStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#open-delete-account').addEventListener('click', () => {
  $('#delete-account-form').classList.remove('hidden');
  $('#delete-account-password').focus();
});

$('#cancel-delete-account').addEventListener('click', () => {
  $('#delete-account-form').classList.add('hidden');
  $('#delete-account-password').value = '';
  setStatus(accountDataStatus, '');
});

$('#delete-account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!window.confirm('Удалить аккаунт со всеми книгами, заметками и планами? Это необратимо.')) return;
  const form = event.target;
  try {
    await withBusy(form.querySelector('button[type=submit]'), accountDataStatus, 'Удаляю аккаунт…', () =>
      postJson('/api/account/delete', { password: $('#delete-account-password').value }));
    $('#delete-account-password').value = '';
    form.classList.add('hidden');
    showAuthGate();
    toast('Аккаунт удалён. Спасибо, что пользовались NBrain.');
  } catch (error) { /* status line already shows it */ }
});

function setupWorkspaceNavigation() {
  const links = Array.from(document.querySelectorAll('[data-section-link]'));
  const panels = Array.from(document.querySelectorAll('[data-workspace-panel]'));
  const availableIds = new Set(panels.map((panel) => panel.dataset.workspacePanel));
  // history mode: 'push' adds an entry (a section the person chose), 'replace'
  // rewrites the current one (a move the script made), 'none' touches nothing.
  const showSection = (id, history = 'replace') => {
    if (!availableIds.has(id)) return;
    panels.forEach((panel) => {
      panel.classList.toggle('workspace-hidden', panel.dataset.workspacePanel !== id);
    });
    document.querySelectorAll('.workspace-nav [data-section-link]').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.sectionLink === id);
    });
    if (id === 'profile-section') $('#profile-section').open = true;
    // The reader has nothing on screen until a book is chosen, so opening the
    // section is itself the request to open the last book being read.
    // Numbers people check are numbers that must be current: the dashboard is
    // refetched every time the section is opened, not once at sign-in.
    if (id === 'progress-section') loadProgress();
    if (id === 'reader-section' && !readerBookId) {
      const picker = $('#reader-book');
      if (picker && picker.value) openReaderPage(picker.value, 0);
    }
    if (history !== 'none' && window.location.hash !== `#${id}`) {
      if (history === 'push') window.history.pushState(null, '', `#${id}`);
      else window.history.replaceState(null, '', `#${id}`);
    }
  };
  // Sections are switched in place, so without a history entry per click the
  // back button walked straight off the site instead of returning to the
  // section the person came from.
  links.forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    showSection(link.dataset.sectionLink, 'push');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  window.addEventListener('popstate', () => {
    const id = window.location.hash.slice(1);
    showSection(availableIds.has(id) ? id : 'analysis-section', 'none');
  });
  goToSection = showSection;
  const requestedId = window.location.hash.slice(1);
  showSection(availableIds.has(requestedId) ? requestedId : 'analysis-section', 'none');
}

// Assigned by setupWorkspaceNavigation; lets the rest of the script move the
// person to a section without duplicating the panel bookkeeping.
let goToSection = () => {};

// The links in e-mail point at /verify and /reset; the server serves the same
// page for both and the token is exchanged here.
function emailLinkAction() {
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token || (path !== '/verify' && path !== '/reset')) return null;
  return { kind: path === '/verify' ? 'verify' : 'reset', token };
}

function clearEmailLinkFromUrl() {
  window.history.replaceState(null, '', '/');
}

async function initializeApp() {
  const linkAction = emailLinkAction();
  let status;
  try {
    status = await api('/api/auth/status');
  } catch (error) {
    // A failed status check is not proof that the session ended: the network
    // may simply be down. Saying so beats silently showing the sign-in form.
    toast('Сервер не отвечает. Обновите страницу, когда связь восстановится.', 'error');
    showAuthGate();
    return;
  }
  registrationOpen = status.registration_open !== false;
  $('#auth-tab-register').classList.toggle('hidden', !registrationOpen);

  if (linkAction && linkAction.kind === 'verify') {
    try {
      await postJson('/api/auth/verify', { token: linkAction.token });
      toast('Адрес почты подтверждён.', 'success');
      if (status.user) status.user.email_verified = true;
    } catch (error) {
      toast(error.message, 'error');
    }
    clearEmailLinkFromUrl();
  }
  if (linkAction && linkAction.kind === 'reset') {
    pendingResetToken = linkAction.token;
    clearEmailLinkFromUrl();
    showAuthGate('reset');
    return;
  }
  if (status.auth_required && !status.authenticated) {
    showAuthGate();
    return;
  }
  hideAuthGate();
  setCurrentUser(status.user);
  if (status.onboarding && !status.onboarding.completed) {
    await openOnboarding();
  }
  await loadWorkspace();
}

let registrationOpen = true;
let pendingResetToken = '';

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await withBusy($('#login-button'), loginStatus, 'Проверяю данные…', () =>
      postJson('/api/auth/login', {
        username: $('#login-username').value,
        password: $('#login-password').value,
      }));
    $('#login-password').value = '';
    hideAuthGate();
    setCurrentUser(payload.user);
    if (payload.onboarding && !payload.onboarding.completed) await openOnboarding();
    await loadWorkspace();
  } catch (error) { /* status line already shows it */ }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    const payload = await withBusy(form.querySelector('button[type=submit]'), loginStatus, 'Создаю аккаунт…', () =>
      postJson('/api/auth/register', {
        email: $('#register-email').value,
        display_name: $('#register-name').value,
        password: $('#register-password').value,
      }));
    $('#login-username').value = $('#register-email').value;
    form.reset();
    showAuthPanel('login');
    // The reply is identical whether or not the address was already taken, so
    // the wording has to fit both cases without hinting which one happened.
    setStatus(loginStatus, payload.mail_configured
      ? 'Готово. Проверьте почту: там письмо с подтверждением. Войти можно уже сейчас.'
      : 'Готово. Отправка почты на сервере не настроена — попросите администратора выдать ссылку подтверждения. Войти можно уже сейчас.');
  } catch (error) { /* status line already shows it */ }
});

$('#forgot-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    const payload = await withBusy(form.querySelector('button[type=submit]'), loginStatus, 'Отправляю…', () =>
      postJson('/api/auth/forgot', { email: $('#forgot-email').value }));
    form.reset();
    setStatus(loginStatus, payload.mail_configured
      ? 'Если такой аккаунт есть, письмо со ссылкой уже отправлено.'
      : 'Отправка почты на сервере не настроена. Обратитесь к администратору — он выдаст ссылку.');
  } catch (error) { /* status line already shows it */ }
});

$('#reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await withBusy(form.querySelector('button[type=submit]'), loginStatus, 'Сохраняю пароль…', () =>
      postJson('/api/auth/reset', { token: pendingResetToken, new_password: $('#reset-password').value }));
    form.reset();
    pendingResetToken = '';
    showAuthPanel('login');
    setStatus(loginStatus, 'Пароль изменён. Теперь войдите с новым паролем.');
  } catch (error) { /* status line already shows it */ }
});

$('#resend-verify').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const payload = await postJson('/api/account/verify/resend', {});
    toast(payload.mail_configured
      ? 'Письмо отправлено ещё раз.'
      : 'Отправка почты не настроена: ссылка записана в журнал сервера, её выдаст администратор.', 'success');
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
});

async function openOnboarding() {
  try {
    if (!interestCatalogue.length) {
      const payload = await api('/api/interests');
      interestCatalogue = payload.interests || [];
    }
    const { profile } = await api('/api/onboarding');
    renderInterestChips(profile.interests || []);
    $('#onboarding-level').value = profile.level || 'intermediate';
    $('#onboarding-minutes').value = profile.daily_minutes || 20;
    $('#onboarding-date').value = profile.target_date || '';
    $('#onboarding-format').value = profile.format || 'mixed';
    $('#onboarding-personalization').checked = profile.personalization !== false;
    $('#onboarding-goals').value = (profile.goals || []).map((goal) => goal.title).join('\n');
    $('#onboarding-read').value = booksToLines(profile.books_read);
    $('#onboarding-wanted').value = booksToLines(profile.books_wanted);
    onboardingGate.classList.remove('hidden');
    $('#onboarding-topics').querySelector('input')?.focus();
  } catch (error) {
    reportError(error, 'Не удалось открыть анкету.');
  }
}

function booksToLines(books) {
  return (books || []).map((book) => (book.author ? `${book.title} — ${book.author}` : book.title)).join('\n');
}

// "Название — Автор" is how people actually write a reading list, so the split
// happens here rather than demanding two fields per book.
function linesToBooks(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((line) => {
      const parts = line.split(/\s+[—–-]\s+/);
      return parts.length > 1
        ? { title: parts.slice(0, -1).join(' — ').trim(), author: parts[parts.length - 1].trim() }
        : { title: line, author: '' };
    });
}

function renderInterestChips(selected) {
  const chosen = new Set(selected || []);
  const render = (host, kind) => {
    host.innerHTML = interestCatalogue
      .filter((interest) => interest.kind === kind)
      .map((interest) => `
        <label class="chip">
          <input type="checkbox" value="${escapeHtml(interest.id)}" ${chosen.has(interest.id) ? 'checked' : ''} />
          <span>${escapeHtml(interest.title)}</span>
        </label>`)
      .join('');
  };
  render($('#onboarding-topics'), 'topic');
  render($('#onboarding-skills'), 'skill');
}

function selectedInterestIds() {
  return Array.from(document.querySelectorAll('#onboarding-topics input:checked, #onboarding-skills input:checked'))
    .map((input) => input.value);
}

$('#onboarding-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await withBusy(form.querySelector('button[type=submit]'), onboardingStatus, 'Сохраняю…', () =>
      postJson('/api/onboarding', {
        level: $('#onboarding-level').value,
        daily_minutes: Number($('#onboarding-minutes').value),
        target_date: $('#onboarding-date').value,
        format: $('#onboarding-format').value,
        personalization: $('#onboarding-personalization').checked,
        interests: selectedInterestIds(),
        goals: $('#onboarding-goals').value.split('\n').map((line) => line.trim()).filter(Boolean).map((title) => ({ title })),
        books_read: linesToBooks($('#onboarding-read').value),
        books_wanted: linesToBooks($('#onboarding-wanted').value),
      }));
    onboardingGate.classList.add('hidden');
    toast('Анкета сохранена. Ответы можно изменить в профиле.', 'success');
    await loadWorkspace({ firstRun: true });
  } catch (error) { /* status line already shows it */ }
});

$('#onboarding-skip').addEventListener('click', async () => {
  onboardingGate.classList.add('hidden');
  toast('Анкету можно заполнить позже — раздел «Профиль».');
  await loadWorkspace({ firstRun: true });
});

const bookStatusLabels = { ready: 'Готово', indexing: 'Индексируется', failed: 'Ошибка' };

function renderBooks(books) {
  // Re-rendering during polling must not silently drop the user's selection.
  const checked = new Set(selectedBookIds());
  bookFilter.innerHTML = '';
  if (!books.length) {
    // A brand-new account owns nothing: libraries are personal, so there is
    // literally nothing to read until this person adds a file. Saying so, and
    // saying what to do about it, beats a bare "no books yet".
    fillBookSelects(books);
    bookList.innerHTML = `
      <div class="empty-state empty-cta">
        <p><strong>Здесь пока пусто.</strong> Библиотека у каждого своя, поэтому первую книгу нужно загрузить самому.</p>
        <p>Подойдёт PDF, EPUB или TXT до 50 МБ. NBrain разберёт текст на фрагменты и после этого сможет отвечать на вопросы по книге со ссылками на страницы.</p>
        <button type="button" id="empty-upload-hint">Загрузить первую книгу</button>
      </div>`;
    const hint = $('#empty-upload-hint');
    if (hint) hint.addEventListener('click', () => {
      goToSection('knowledge-section');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const picker = $('#book-file');
      if (picker) picker.click();
    });
    return;
  }
  fillBookSelects(books);
  bookList.innerHTML = books.map((book) => {
    const detail = book.status === 'ready'
      ? `${book.page_count} стр. · ${book.chunk_count} фрагментов`
      : book.status === 'failed'
        ? (book.error || 'Не удалось проиндексировать.')
        : 'Индексируется на сервере, вкладку можно закрыть…';
    const disabled = book.indexing ? ' disabled' : '';
    return `<article class="book-row${book.indexing ? ' is-indexing' : ''}">
      <div><strong>${escapeHtml(displayBookTitle(book.title))}</strong><span>${escapeHtml(detail)}</span></div>
      <div class="book-row-side">
        <span class="book-status ${escapeHtml(book.status)}">${escapeHtml(bookStatusLabels[book.status] || book.status)}</span>
        <div class="book-actions"><button type="button" class="book-action" data-book-reindex="${escapeHtml(book.id)}"${disabled}>Переиндексировать</button><button type="button" class="book-action danger" data-book-delete="${escapeHtml(book.id)}"${disabled}>Удалить</button></div>
      </div>
    </article>`;
  }).join('');
  for (const book of books.filter((book) => book.status === 'ready')) {
    const label = document.createElement('label');
    label.className = 'book-choice';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(book.id)}" /><span>${escapeHtml(displayBookTitle(book.title))}</span><small>${book.page_count} стр.</small>`;
    if (checked.has(book.id)) label.querySelector('input').checked = true;
    bookFilter.append(label);
  }
}

let indexingPollTimer = null;

function stopIndexingPoll() {
  if (indexingPollTimer) {
    window.clearTimeout(indexingPollTimer);
    indexingPollTimer = null;
  }
}

function scheduleIndexingPoll(books) {
  stopIndexingPoll();
  if (!currentUser && authGate.classList.contains('hidden') === false) return;
  if (!books.some((book) => book.indexing)) return;
  // A hidden tab does not need three-second updates; the poll resumes on the
  // visibilitychange below when the person comes back.
  if (document.hidden) return;
  indexingPollTimer = window.setTimeout(loadBooks, 3000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopIndexingPoll();
  else if (currentUser) loadBooks();
});

bookList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-book-reindex], [data-book-delete]');
  if (!button) return;
  const reindexId = button.dataset.bookReindex;
  const deleteId = button.dataset.bookDelete;
  if (deleteId && !window.confirm('Удалить книгу и её поисковый индекс? Действие необратимо.')) return;
  button.disabled = true;
  try {
    if (reindexId) {
      await api('/api/books/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reindexId }),
      });
      setStatus(uploadStatus, 'Индексирую заново на сервере — вкладку можно закрыть.');
    } else {
      await api('/api/books/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteId }),
      });
      setStatus(uploadStatus, 'Книга удалена.');
    }
    await loadBooks();
  } catch (error) {
    setStatus(uploadStatus, error.message, true);
    button.disabled = false;
  }
});

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
  bookList.setAttribute('aria-busy', 'true');
  try {
    const { books } = await api('/api/books');
    renderBooks(books);
    scheduleIndexingPoll(books);
  } catch (error) {
    if (error.message !== SESSION_EXPIRED) {
      bookList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
      reportError(error, 'Не удалось загрузить библиотеку.');
    }
  } finally {
    bookList.removeAttribute('aria-busy');
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
    $('#profile-title').textContent = profile.name ? `Профиль: ${profile.name}` : 'Профиль';
  } catch (error) {
    setStatus(profileStatus, error.message, true);
    reportError(error, 'Не удалось загрузить профиль.');
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
    $('#profile-title').textContent = profile.name ? `Профиль: ${profile.name}` : 'Профиль';
    // The name in the header is the same name, so it changes here and now
    // instead of waiting for the next sign-in.
    if (currentUser) {
      setCurrentUser({ ...currentUser, display_name: profile.name || currentUser.username });
    }
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
  actionList.setAttribute('aria-busy', 'true');
  try {
    const { actions } = await api('/api/actions');
    renderActions(actions);
  } catch (error) {
    if (error.message !== SESSION_EXPIRED) {
      actionList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
      reportError(error, 'Не удалось загрузить действия.');
    }
  } finally {
    actionList.removeAttribute('aria-busy');
  }
}

async function loadMemories() {
  memoryList.setAttribute('aria-busy', 'true');
  try {
    const { memories } = await api('/api/memories');
    renderMemories(memories);
  } catch (error) {
    if (error.message !== SESSION_EXPIRED) {
      memoryList.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
      reportError(error, 'Не удалось загрузить сохранённые идеи.');
    }
  } finally {
    memoryList.removeAttribute('aria-busy');
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

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_LIBRARY_IMPORT_BYTES = 8 * 1024 * 1024;
const ALLOWED_BOOK_EXTENSIONS = ['.pdf', '.epub', '.txt'];

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

// The file input is visually hidden, so without this the label kept saying
// "Выбрать книгу" after a file was picked and there was no way to tell whether
// the click had registered.
function bindFilePicker(inputSelector, labelText, statusElement, maxBytes, extensions) {
  const input = $(inputSelector);
  if (!input) return;
  const caption = input.parentElement.querySelector('span');
  const original = caption ? caption.textContent : labelText;
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) {
      if (caption) caption.textContent = original;
      setStatus(statusElement, '');
      return;
    }
    if (caption) caption.textContent = `${file.name} · ${formatBytes(file.size)}`;
    const name = file.name.toLowerCase();
    if (extensions && !extensions.some((extension) => name.endsWith(extension))) {
      setStatus(statusElement, `Поддерживаются ${extensions.join(', ')}.`, true);
      return;
    }
    // Checking here saves uploading fifty megabytes only to be refused.
    if (file.size > maxBytes) {
      setStatus(statusElement, `Файл больше ${formatBytes(maxBytes)} — сервер его не примет.`, true);
      return;
    }
    setStatus(statusElement, '');
  });
}

bindFilePicker('#book-file', 'Выбрать книгу', uploadStatus, MAX_UPLOAD_BYTES, ALLOWED_BOOK_EXTENSIONS);
bindFilePicker('#development-library-file', 'Импортировать Excel', $('#development-import-status'),
  MAX_LIBRARY_IMPORT_BYTES, ['.xlsx']);

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#book-file');
  const file = input.files[0];
  if (!file) {
    setStatus(uploadStatus, 'Сначала выберите файл книги.', true);
    return;
  }
  const name = file.name.toLowerCase();
  if (!ALLOWED_BOOK_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    setStatus(uploadStatus, `Поддерживаются ${ALLOWED_BOOK_EXTENSIONS.join(', ')}.`, true);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus(uploadStatus, `Файл больше ${formatBytes(MAX_UPLOAD_BYTES)} — сервер его не примет.`, true);
    return;
  }
  const button = $('#upload-button');
  button.disabled = true;
  setStatus(uploadStatus, `Загружаю «${file.name}» (${formatBytes(file.size)})…`);
  try {
    await api('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    // Indexing now runs on the server; the list below polls until it finishes.
    setStatus(uploadStatus, `«${file.name}» загружена. Индексация идёт на сервере — вкладку можно закрыть.`);
    input.value = '';
    input.dispatchEvent(new Event('change'));
    await loadBooks();
  } catch (error) {
    if (error.message !== SESSION_EXPIRED) setStatus(uploadStatus, error.message, true);
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

// ==========================================================================
// Обучение: планы, занятия, тесты, карточки
// ==========================================================================

const planStatus = $('#plan-status');
let readyBooks = [];
let currentPlan = null;
let currentLesson = null;
let quizChecked = false;

function fillBookSelects(books) {
  readyBooks = books.filter((book) => book.status === 'ready');
  const options = readyBooks.map((book) => `<option value="${escapeHtml(book.id)}">${escapeHtml(displayBookTitle(book.title))}</option>`).join('');
  for (const selector of ['#plan-book', '#reader-book']) {
    const select = $(selector);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = options || '<option value="">Нет готовых книг</option>';
    if (previous && readyBooks.some((book) => book.id === previous)) select.value = previous;
  }
}

function planDate(value) {
  if (!value) return '';
  const [year, month, day] = String(value).split('-');
  return `${day}.${month}.${year}`;
}

async function loadPlans() {
  try {
    const { plans } = await api('/api/plans');
    const host = $('#plan-list');
    if (!plans.length) {
      host.innerHTML = readyBooks.length
        ? '<p class="empty-state">Планов пока нет. Выберите книгу выше и составьте первый.</p>'
        : '<p class="empty-state">Сначала загрузите и дождитесь индексации книги в разделе «Книги».</p>';
      return;
    }
    host.innerHTML = plans.map((plan) => `
      <article class="plan-row">
        <div>
          <h4>${escapeHtml(plan.book_title)}</h4>
          <p class="recommendation-meta">${plan.done_lessons || 0} из ${plan.total_lessons || 0} занятий${plan.target_date ? ` · до ${planDate(plan.target_date)}` : ''} · ${plan.daily_minutes} мин в день</p>
          <div class="progress-bar"><span data-width="${plan.percent}%"></span></div>
        </div>
        <div class="plan-row-actions">
          <button type="button" data-open-plan="${escapeHtml(plan.id)}">Открыть</button>
          <button type="button" class="button-secondary danger" data-delete-plan="${escapeHtml(plan.id)}">Удалить</button>
        </div>
      </article>`).join('');
    applySizes(host);
  } catch (error) {
    reportError(error, 'Не удалось загрузить планы.');
  }
}

$('#plan-list').addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open-plan]');
  const remove = event.target.closest('[data-delete-plan]');
  if (open) return openPlan(open.dataset.openPlan);
  if (!remove) return;
  if (!window.confirm('Удалить план вместе с занятиями и вопросами? Карточки останутся.')) return;
  try {
    await postJson('/api/plans/delete', { id: remove.dataset.deletePlan });
    toast('План удалён.');
    await loadPlans();
  } catch (error) { reportError(error); }
});

async function openPlan(planId) {
  try {
    const { plan } = await api(`/api/plan?id=${encodeURIComponent(planId)}`);
    currentPlan = plan;
    renderPlan(plan);
  } catch (error) { reportError(error); }
}

function lessonStatusLabel(lesson) {
  if (lesson.status === 'done') return `<span class="pill pill-done">Пройдено${lesson.score !== null ? ` · ${lesson.score}%` : ''}</span>`;
  if (lesson.generated_at) return '<span class="pill pill-progress">Материал готов</span>';
  return '<span class="pill">Запланировано</span>';
}

function renderPlan(plan) {
  $('#learning-plans-view').classList.add('hidden');
  $('#lesson-view').classList.remove('hidden');
  $('#lesson-body').innerHTML = `
    <div class="section-heading">
      <div>
        <p class="section-label">ПЛАН</p>
        <h2>${escapeHtml(plan.book_title)}</h2>
        <p>${plan.done_lessons} из ${plan.total_lessons} занятий пройдено${plan.target_date ? ` · цель ${planDate(plan.target_date)}` : ''} · осталось примерно ${plan.minutes_left} мин.</p>
        ${plan.goal ? `<p class="field-help">Ваша цель: ${escapeHtml(plan.goal)}</p>` : ''}
      </div>
    </div>
    <div class="progress-bar big"><span data-width="${plan.percent}%"></span></div>
    <div class="lesson-list">${plan.lessons.map((lesson) => `
      <article class="lesson-row${lesson.status === 'done' ? ' is-done' : ''}">
        <div>
          <h4>${escapeHtml(lesson.title)}</h4>
          <p class="recommendation-meta">стр. ${lesson.page_from}–${lesson.page_to} · ${lesson.estimated_minutes} мин${lesson.scheduled_for ? ` · ${planDate(lesson.scheduled_for)}` : ''}</p>
        </div>
        <div class="lesson-row-side">${lessonStatusLabel(lesson)}
          <button type="button" data-open-lesson="${escapeHtml(lesson.id)}">${lesson.status === 'done' ? 'Повторить' : 'Открыть'}</button>
        </div>
      </article>`).join('')}</div>`;
  applySizes($('#lesson-body'));
}

$('#lesson-body').addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open-lesson]');
  if (open) return openLesson(open.dataset.openLesson);
  const generate = event.target.closest('#lesson-generate');
  if (generate) return generateLesson(generate.dataset.lessonId, generate.dataset.force === '1');
  const backToPlan = event.target.closest('#lesson-to-plan');
  if (backToPlan && currentPlan) return openPlan(currentPlan.id);
  const nav = event.target.closest('[data-goto-lesson]');
  if (nav) return openLesson(nav.dataset.gotoLesson);
  const read = event.target.closest('[data-read-pages]');
  if (read) {
    const select = $('#reader-book');
    if (select) select.value = read.dataset.readBook;
    goToSection('reader-section');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return openReaderPage(read.dataset.readBook, Number(read.dataset.readPages));
  }
});

async function openLesson(lessonId) {
  try {
    const { lesson } = await api(`/api/lesson?id=${encodeURIComponent(lessonId)}`);
    currentLesson = lesson;
    quizChecked = false;
    $('#learning-plans-view').classList.add('hidden');
    $('#lesson-view').classList.remove('hidden');
    renderLesson(lesson);
  } catch (error) { reportError(error); }
}

function renderIdeaList(items) {
  return items.map((item) => `<li>${escapeHtml(item.idea)}${item.why ? ` — <span class="muted-text">${escapeHtml(item.why)}</span>` : ''}${item.page ? ` <em class="page-ref">стр. ${item.page}</em>` : ''}</li>`).join('');
}

function renderLesson(lesson) {
  const generated = lesson.generated;
  $('#lesson-body').innerHTML = `
    <div class="section-heading">
      <div>
        <p class="section-label">ЗАНЯТИЕ ${lesson.ordinal}</p>
        <h2>${escapeHtml(lesson.title)}</h2>
        <p class="recommendation-meta">${escapeHtml(lesson.book_title)} · стр. ${lesson.page_from}–${lesson.page_to} · ${lesson.estimated_minutes} мин${lesson.scheduled_for ? ` · ${planDate(lesson.scheduled_for)}` : ''}</p>
        ${lesson.goal ? `<p>${escapeHtml(lesson.goal)}</p>` : ''}
      </div>
      <div class="lesson-row-side">
        <button type="button" id="lesson-to-plan" class="button-secondary">К плану</button>
        <button type="button" data-read-book="${escapeHtml(lesson.book_id)}" data-read-pages="${lesson.page_from}" class="button-secondary">Читать страницы</button>
      </div>
    </div>
    ${generated ? '' : `
      <div class="empty-cta">
        <p><strong>Материал занятия ещё не сформирован.</strong> NBrain прочитает страницы ${lesson.page_from}–${lesson.page_to} вашей книги и составит конспект, ключевые идеи, термины, цитаты, пять вопросов и шесть карточек.</p>
        <p>Это один запрос к языковой модели, результат сохраняется — повторно платить не придётся.</p>
        <button type="button" id="lesson-generate" data-lesson-id="${escapeHtml(lesson.id)}">Сформировать материал занятия</button>
      </div>`}
    ${generated ? `
      <p class="disclaimer-note">${escapeHtml(lesson.disclaimer)}</p>
      <h3>Краткое содержание</h3>
      <div class="lesson-summary">${lesson.summary.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part)}</p>`).join('')}</div>
      ${lesson.key_ideas.length ? `<h3>Ключевые идеи</h3><ul class="lesson-ul">${renderIdeaList(lesson.key_ideas)}</ul>` : ''}
      ${lesson.terms.length ? `<h3>Термины</h3><ul class="lesson-ul">${lesson.terms.map((term) => `<li><strong>${escapeHtml(term.term)}</strong> — ${escapeHtml(term.meaning)}${term.page ? ` <em class="page-ref">стр. ${term.page}</em>` : ''}</li>`).join('')}</ul>` : ''}
      ${lesson.quotes.length ? `<h3>Цитаты</h3>${lesson.quotes.map((quote) => `<blockquote>${escapeHtml(quote.text)}${quote.page ? `<em class="page-ref"> стр. ${quote.page}</em>` : ''}</blockquote>`).join('')}` : ''}
      ${lesson.practice ? `<h3>Практика</h3><p>${escapeHtml(lesson.practice)}</p>` : ''}
      ${lesson.questions.length ? `<h3>Проверьте себя</h3><form id="quiz-form" class="quiz-form">${lesson.questions.map((question, index) => `
        <fieldset class="quiz-question" data-question="${escapeHtml(question.id)}">
          <legend>${index + 1}. ${escapeHtml(question.prompt)}</legend>
          ${question.options.map((option, optionIndex) => `
            <label class="quiz-option"><input type="radio" name="q-${escapeHtml(question.id)}" value="${optionIndex}" /> <span>${escapeHtml(option)}</span></label>`).join('')}
          <p class="quiz-feedback hidden"></p>
        </fieldset>`).join('')}
        <div class="form-actions"><button type="submit">Проверить ответы</button>
          <button type="button" id="lesson-generate" class="button-secondary" data-lesson-id="${escapeHtml(lesson.id)}" data-force="1">Пересобрать материал</button></div>
        <p id="quiz-status" class="status" aria-live="polite"></p>
      </form>` : ''}
      <div class="lesson-nav">
        ${lesson.prev_lesson ? `<button type="button" class="button-secondary" data-goto-lesson="${escapeHtml(lesson.prev_lesson)}">← Предыдущее</button>` : '<span></span>'}
        ${lesson.next_lesson ? `<button type="button" class="button-secondary" data-goto-lesson="${escapeHtml(lesson.next_lesson)}">Следующее →</button>` : '<span></span>'}
      </div>` : ''}`;
  const quizForm = $('#quiz-form');
  if (quizForm) quizForm.addEventListener('submit', submitQuiz);
}

async function generateLesson(lessonId, force) {
  const button = $('#lesson-generate');
  if (button) button.disabled = true;
  toast('Читаю страницы и собираю материал — это занимает до минуты.');
  try {
    const { lesson } = await postJson('/api/lesson/generate', { id: lessonId, force });
    currentLesson = lesson;
    renderLesson(lesson);
    toast('Материал занятия готов.', 'success');
  } catch (error) {
    reportError(error, 'Не удалось собрать материал занятия.');
    if (button) button.disabled = false;
  }
}

async function submitQuiz(event) {
  event.preventDefault();
  const form = event.target;
  const answers = {};
  let unanswered = 0;
  form.querySelectorAll('.quiz-question').forEach((field) => {
    const chosen = field.querySelector('input:checked');
    if (chosen) answers[field.dataset.question] = Number(chosen.value);
    else unanswered += 1;
  });
  if (unanswered) {
    setStatus($('#quiz-status'), `Не отвечено вопросов: ${unanswered}. Ответьте на все и повторите.`, true);
    return;
  }
  try {
    const result = await withBusy(form.querySelector('button[type=submit]'), $('#quiz-status'), 'Проверяю…', () =>
      postJson('/api/lesson/quiz', { lesson_id: currentLesson.id, answers }));
    quizChecked = true;
    result.results.forEach((item) => {
      const field = form.querySelector(`[data-question="${CSS.escape(item.id)}"]`);
      if (!field) return;
      field.classList.add(item.correct ? 'is-correct' : 'is-wrong');
      const feedback = field.querySelector('.quiz-feedback');
      feedback.classList.remove('hidden');
      feedback.textContent = item.correct
        ? `Верно. ${item.explanation}`
        : `Правильный ответ: ${item.options[item.answer]}. ${item.explanation}`;
    });
    setStatus($('#quiz-status'), `${result.correct} из ${result.total} — ${result.score}%. ${result.advice}`);
    toast(result.passed ? `Занятие пройдено: ${result.score}%` : `Результат ${result.score}% — стоит повторить`, result.passed ? 'success' : 'info');
    await Promise.all([loadFlashcards(), loadPlans(), loadProgress()]);
  } catch (error) { /* status line shows it */ }
}

$('#lesson-back').addEventListener('click', () => {
  $('#lesson-view').classList.add('hidden');
  $('#learning-plans-view').classList.remove('hidden');
  loadPlans();
});

$('#plan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const bookId = $('#plan-book').value;
  if (!bookId) {
    setStatus(planStatus, 'Сначала загрузите книгу и дождитесь индексации.', true);
    return;
  }
  try {
    const { plan } = await withBusy(event.target.querySelector('button[type=submit]'), planStatus, 'Составляю план…', () =>
      postJson('/api/plans', {
        book_id: bookId,
        daily_minutes: Number($('#plan-minutes').value),
        target_date: $('#plan-date').value,
        goal: $('#plan-goal').value,
      }));
    toast(`План готов: ${plan.total_lessons} занятий.`, 'success');
    await loadPlans();
    openPlan(plan.id);
  } catch (error) { /* status line shows it */ }
});

// --- Карточки ---
let cardQueue = [];
let cardIndex = 0;
let cardsReviewed = 0;

async function loadFlashcards() {
  try {
    const payload = await api('/api/flashcards');
    cardQueue = payload.cards || [];
    cardIndex = 0;
    renderFlashcards(payload);
  } catch (error) {
    reportError(error, 'Не удалось загрузить карточки.');
  }
}

function renderFlashcards(payload) {
  const host = $('#flashcard-panel');
  if (!payload.total) {
    host.innerHTML = '<p class="empty-state">Карточки появятся, когда вы сформируете материал первого занятия.</p>';
    return;
  }
  if (!cardQueue.length || cardIndex >= cardQueue.length) {
    host.innerHTML = `<div class="empty-cta"><p><strong>На сегодня повторение закончено.</strong> Всего карточек: ${payload.total}. Следующие вернутся по расписанию.</p></div>`;
    return;
  }
  const card = cardQueue[cardIndex];
  host.innerHTML = `
    <div class="flashcard">
      <p class="recommendation-meta">${escapeHtml(card.book_title || '')}${card.source_pages ? ` · стр. ${escapeHtml(card.source_pages)}` : ''} · осталось ${cardQueue.length - cardIndex}</p>
      <h4>${escapeHtml(card.front)}</h4>
      <p class="flashcard-back hidden">${escapeHtml(card.back)}</p>
      <div class="form-actions">
        <button type="button" id="card-show">Показать ответ</button>
      </div>
      <div class="form-actions card-grades hidden">
        <button type="button" class="button-secondary" data-grade="again">Не вспомнил</button>
        <button type="button" class="button-secondary" data-grade="hard">С трудом</button>
        <button type="button" data-grade="good">Вспомнил</button>
        <button type="button" class="button-secondary" data-grade="easy">Легко</button>
      </div>
    </div>`;
}

$('#flashcard-panel').addEventListener('click', async (event) => {
  if (event.target.closest('#card-show')) {
    $('.flashcard-back').classList.remove('hidden');
    $('.card-grades').classList.remove('hidden');
    $('#card-show').classList.add('hidden');
    return;
  }
  const grade = event.target.closest('[data-grade]');
  if (!grade) return;
  const card = cardQueue[cardIndex];
  grade.disabled = true;
  try {
    const result = await postJson('/api/flashcards/review', { id: card.id, grade: grade.dataset.grade });
    cardsReviewed += 1;
    cardIndex += 1;
    toast(`Карточка вернётся ${result.next_in}.`);
    if (cardIndex >= cardQueue.length) {
      const payload = await postJson('/api/flashcards/finish', { reviewed: cardsReviewed });
      cardsReviewed = 0;
      cardQueue = [];
      renderFlashcards(payload);
      await loadProgress();
    } else {
      renderFlashcards({ total: cardQueue.length });
    }
  } catch (error) {
    reportError(error);
    grade.disabled = false;
  }
});

// ==========================================================================
// Читалка
// ==========================================================================

let readerBookId = '';
let readerPage = 1;
let readerOpenedAt = 0;

async function openReaderPage(bookId, page) {
  if (!bookId) {
    $('#reader-body').innerHTML = '<p class="empty-state">Выберите книгу — или сначала загрузите её в разделе «Книги».</p>';
    return;
  }
  await flushReadingTime();
  readerBookId = bookId;
  $('#reader-body').setAttribute('aria-busy', 'true');
  try {
    const state = await api(`/api/reader/state?book_id=${encodeURIComponent(bookId)}`);
    // Page 0 means "wherever I stopped last time" — that is what makes the
    // reader worth opening on a second device.
    const wanted = page || state.page_no || 1;
    const pagePayload = await api(`/api/reader/page?book_id=${encodeURIComponent(bookId)}&page=${wanted}`);
    readerPage = pagePayload.page_no;
    readerOpenedAt = Date.now();
    renderReader(pagePayload, state);
  } catch (error) {
    $('#reader-body').innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
    reportError(error, 'Не удалось открыть книгу.');
  } finally {
    $('#reader-body').removeAttribute('aria-busy');
  }
}

function renderReader(page, state) {
  $('#reader-body').innerHTML = `
    <div class="reader-toolbar">
      <div class="progress-bar big"><span data-width="${state.percent}%"></span></div>
      <p class="recommendation-meta">Страница ${page.page_no} из ${page.total_pages} · прочитано ${state.percent}% · осталось примерно ${state.minutes_left} мин.</p>
    </div>
    <div class="reader-page">${page.content.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part)}</p>`).join('')}</div>
    <div class="reader-actions">
      <button type="button" class="button-secondary" data-reader-page="${page.prev_page || ''}" ${page.prev_page ? '' : 'disabled'}>← Назад</button>
      <button type="button" id="reader-bookmark" class="button-secondary">${page.bookmarked ? '★ В закладках' : '☆ В закладки'}</button>
      <button type="button" id="reader-note" class="button-secondary">Заметка к странице</button>
      <button type="button" data-reader-page="${page.next_page || ''}" ${page.next_page ? '' : 'disabled'}>Дальше →</button>
    </div>
    <form id="reader-note-form" class="hidden">
      <label for="reader-note-quote">Цитата со страницы<input id="reader-note-quote" maxlength="1000" placeholder="Необязательно" /></label>
      <label for="reader-note-text">Ваша мысль<textarea id="reader-note-text" rows="3" required></textarea></label>
      <div class="form-actions"><button type="submit">Сохранить заметку</button>
        <button type="button" id="reader-note-cancel" class="button-secondary">Отмена</button></div>
    </form>
    ${page.notes.length ? `<h3>Заметки к этой странице</h3><div class="note-list">${page.notes.map((note) => `
      <article class="note-row">
        ${note.quote ? `<blockquote>${escapeHtml(note.quote)}</blockquote>` : ''}
        <p>${escapeHtml(note.content)}</p>
        <button type="button" class="link-button" data-delete-note="${escapeHtml(note.id)}">Удалить</button>
      </article>`).join('')}</div>` : ''}
    ${state.bookmarks.length ? `<h3>Закладки</h3><div class="chip-grid">${state.bookmarks.map((mark) => `
      <button type="button" class="chip-button" data-reader-page="${mark.page_no}">стр. ${mark.page_no}</button>`).join('')}</div>` : ''}`;
  applySizes($('#reader-body'));
}

async function flushReadingTime() {
  if (!readerBookId || !readerOpenedAt) return;
  const seconds = Math.min(3600, Math.round((Date.now() - readerOpenedAt) / 1000));
  readerOpenedAt = 0;
  if (seconds < 3) return;
  try {
    await postJson('/api/reader/progress', { book_id: readerBookId, page_no: readerPage, seconds });
  } catch (error) { /* progress is best-effort; never block the reader */ }
}

$('#reader-body').addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-reader-page]');
  if (nav && nav.dataset.readerPage) return openReaderPage(readerBookId, Number(nav.dataset.readerPage));
  if (event.target.closest('#reader-bookmark')) {
    try {
      const result = await postJson('/api/reader/bookmark', { book_id: readerBookId, page_no: readerPage });
      toast(result.bookmarked ? 'Закладка поставлена.' : 'Закладка снята.');
      return openReaderPage(readerBookId, readerPage);
    } catch (error) { return reportError(error); }
  }
  if (event.target.closest('#reader-note')) {
    $('#reader-note-form').classList.remove('hidden');
    $('#reader-note-text').focus();
    return;
  }
  if (event.target.closest('#reader-note-cancel')) {
    $('#reader-note-form').classList.add('hidden');
    return;
  }
  const removeNote = event.target.closest('[data-delete-note]');
  if (removeNote) {
    try {
      await postJson('/api/notes/delete', { id: removeNote.dataset.deleteNote });
      toast('Заметка удалена.');
      return openReaderPage(readerBookId, readerPage);
    } catch (error) { return reportError(error); }
  }
});

$('#reader-body').addEventListener('submit', async (event) => {
  if (event.target.id !== 'reader-note-form') return;
  event.preventDefault();
  try {
    await postJson('/api/notes', {
      book_id: readerBookId,
      page_no: readerPage,
      quote: $('#reader-note-quote').value,
      content: $('#reader-note-text').value,
    });
    toast('Заметка сохранена.', 'success');
    await openReaderPage(readerBookId, readerPage);
  } catch (error) { reportError(error); }
});

$('#reader-book').addEventListener('change', (event) => openReaderPage(event.target.value, 1));
window.addEventListener('beforeunload', flushReadingTime);

// ==========================================================================
// Прогресс
// ==========================================================================


// Политика безопасности запрещает атрибут style в разметке — иначе полосы
// прогресса рисовались бы пустыми, а браузер молча сыпал бы предупреждениями.
// Размеры задаются через CSSOM уже после вставки: это CSP не запрещает.
function applySizes(root) {
  if (!root) return;
  root.querySelectorAll('[data-width]').forEach((node) => { node.style.width = node.dataset.width; });
  root.querySelectorAll('[data-height]').forEach((node) => { node.style.height = node.dataset.height; });
}

function statTile(value, label) {
  return `<div class="stat-tile"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

async function loadProgress() {
  const host = $('#progress-body');
  host.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/progress');
    const peak = Math.max(1, ...data.minutes_by_day.map((day) => day.minutes));
    host.innerHTML = `
      <div class="stat-row">
        ${statTile(data.streak, data.streak === 1 ? 'день подряд' : 'дней подряд')}
        ${statTile(data.minutes_total, 'минут занятий')}
        ${statTile(data.lessons_done, 'занятий пройдено')}
        ${statTile(data.average_score === null ? '—' : `${data.average_score}%`, 'средний балл')}
        ${statTile(data.cards_due, 'карточек к повторению')}
        ${statTile(data.notes_total, 'заметок')}
      </div>
      ${data.minutes_by_day.length ? `<h3>Занятия за 30 дней</h3>
        <div class="day-chart" role="img" aria-label="Минуты занятий по дням за последние 30 дней">
          ${data.minutes_by_day.map((day) => `<span title="${escapeHtml(day.day)}: ${day.minutes} мин"${day.minutes ? '' : ' data-empty="1"'} data-height="${day.minutes ? Math.max(8, Math.round(100 * day.minutes / peak)) : 4}%"></span>`).join('')}
        </div>` : '<p class="empty-state">Данных пока нет — статистика появится после первого занятия.</p>'}
      ${data.upcoming.length ? `<h3>Ближайшие занятия${data.overdue_lessons ? ` · просрочено ${data.overdue_lessons}` : ''}</h3>
        <div class="lesson-list">${data.upcoming.map((lesson) => `
          <article class="lesson-row">
            <div><h4>${escapeHtml(lesson.title)}</h4>
              <p class="recommendation-meta">${escapeHtml(lesson.book_title)} · ${lesson.estimated_minutes} мин${lesson.scheduled_for ? ` · ${planDate(lesson.scheduled_for)}` : ''}</p></div>
            <button type="button" data-progress-lesson="${escapeHtml(lesson.id)}">Открыть</button>
          </article>`).join('')}</div>` : ''}
      ${data.reading.length ? `<h3>Чтение</h3>
        <div class="lesson-list">${data.reading.map((item) => `
          <article class="lesson-row">
            <div><h4>${escapeHtml(item.book_title)}</h4>
              <p class="recommendation-meta">страница ${item.page_no} из ${item.total_pages} · ${item.percent}%</p>
              <div class="progress-bar"><span data-width="${item.percent}%"></span></div></div>
            <button type="button" class="button-secondary" data-progress-book="${escapeHtml(item.book_id)}">Продолжить</button>
          </article>`).join('')}</div>` : ''}
      <h3>Достижения</h3>
      <div class="chip-grid">${data.achievements.map((item) => `
        <span class="achievement${item.earned ? ' is-earned' : ''}" title="${escapeHtml(item.description)}">${item.earned ? '★' : '☆'} ${escapeHtml(item.title)}</span>`).join('')}</div>`;
    applySizes(host);
  } catch (error) {
    if (error.message !== SESSION_EXPIRED) {
      host.innerHTML = `<p class="empty-state error">${escapeHtml(error.message)}</p>`;
      reportError(error, 'Не удалось загрузить статистику.');
    }
  } finally {
    host.removeAttribute('aria-busy');
  }
}

$('#progress-body').addEventListener('click', (event) => {
  const lesson = event.target.closest('[data-progress-lesson]');
  if (lesson) {
    goToSection('learning-section');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return openLesson(lesson.dataset.progressLesson);
  }
  const book = event.target.closest('[data-progress-book]');
  if (book) {
    const select = $('#reader-book');
    if (select) select.value = book.dataset.progressBook;
    goToSection('reader-section');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return openReaderPage(book.dataset.progressBook, 0);
  }
});

$('#question-form').addEventListener('submit', (event) => { event.preventDefault(); findOrAnswer(true); });
$('#search-button').addEventListener('click', () => findOrAnswer(false));
$('#refresh-books').addEventListener('click', loadBooks);
updateResponseFormat();
setupWorkspaceNavigation();
initializeApp();
