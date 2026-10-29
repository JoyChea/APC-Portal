const STORAGE_KEY = 'portal-web-preferences-v1';
const THEME_STORAGE_KEY = 'portal-web-theme-v1';
const OFFLINE_DATA_CACHE = 'portal-web-v5-data';
const { DAYS, PERIODS } = window.PortalCalendar;
const IGNORED = new Set(['a','an','the','and','or','for','to','of','in','on','at','me','my','i','am','is','are','find','open','show','give','get','link','page','website','site','lesson','unit','topic','please','can','you','where','what','whats','about','from','current','school','portal','apc','up','with','it','this','that']);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeHttps = value => { try { const url = new URL(String(value || '').trim()); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const displayYear = value => `Year ${value}`;
const cellValue = id => id && state?.courses?.[id] ? id : '';
const courseLabel = course => course?.displayName || course?.name || 'Free / Study';
const activeUrl = course => safeHttps(course?.unitURL) || safeHttps(course?.homepageURL);

let state = null;
let offerings = [];
let catalogue = [];
let indexedCatalogue = [];
let pickerMode = 'setup';
let pickerSelection = new Set();
let assignSlot = null;
let pendingCandidate = null;
let toastTimer = 0;
let finderTimer = 0;
let deferredInstallPrompt = null;

function emptyTimetable() { return Object.fromEntries(DAYS.map(day => [day, Array(PERIODS.length).fill('')])); }

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.courses || typeof raw.courses !== 'object') return null;
  const courses = {};
  for (const [id, course] of Object.entries(raw.courses)) {
    if (!course || typeof course !== 'object' || !course.homepageURL) continue;
    const unitURL = safeHttps(course.unitURL) || null;
    const savedUnitTitle = String(course.unitTitle || 'Unit not set');
    courses[id] = {
      id,
      displayName: String(course.displayName || course.name || 'Subject'),
      year: Number(course.year) || null,
      subject: String(course.subject || ''),
      level: String(course.level || 'Standard'),
      program: course.program || null,
      homepageURL: String(course.homepageURL),
      unitURL,
      unitTitle: unitURL && savedUnitTitle === 'Unit not set' ? 'Custom unit page' : savedUnitTitle
    };
  }
  if (!Object.keys(courses).length) return null;
  const timetable = emptyTimetable();
  for (const day of DAYS) {
    const values = Array.isArray(raw.timetable?.[day]) ? raw.timetable[day] : [];
    timetable[day] = PERIODS.map((_, index) => values[index] && courses[values[index]] ? values[index] : '');
  }
  const shortcuts = Array.isArray(raw.shortcuts) ? raw.shortcuts.filter(id => courses[id]).slice(0, 6) : [];
  return { courses, timetable, shortcuts };
}

function saveState() {
  if (!state || !Object.keys(state.courses).length) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { showToast('Could not save browser preferences. Check this browser’s storage settings.'); }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setTheme(theme, persist = false) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  const isDark = nextTheme === 'dark';
  const toggle = $('#themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    toggle.setAttribute('aria-pressed', String(!isDark));
  }
  const icon = $('#themeToggleIcon');
  const label = $('#themeToggleLabel');
  if (icon) icon.textContent = isDark ? '☼' : '☾';
  if (label) label.textContent = isDark ? 'Light mode' : 'Dark mode';
  const themeColor = $('meta[name="theme-color"]');
  if (themeColor) themeColor.content = isDark ? '#0b1020' : '#f3f6fb';
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme); }
    catch { showToast('Theme changed for this visit, but could not be saved in browser storage.'); }
  }
}

function setView(name) {
  for (const view of $$('.view')) view.hidden = view.id !== `view-${name}`;
  for (const button of $$('.nav-button')) button.classList.toggle('active', button.dataset.view === name);
  if (name === 'settings') renderSettings();
  if (name === 'home') renderDashboard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function subjectInitials(course) {
  const words = (course?.subject || course?.displayName || 'P').split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

function selectedCourses() {
  return Object.values(state?.courses || {}).sort((a, b) => a.year - b.year || a.displayName.localeCompare(b.displayName));
}

function renderDashboard() {
  if (!state) return;
  const now = new Date();
  $('#todayDate').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#greeting').textContent = `${now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening'}`;
  const todayIndex = now.getDay();
  const weekday = todayIndex >= 1 && todayIndex <= 5;
  const day = weekday ? DAYS[todayIndex - 1] : null;
  const timeInfo = getSchoolStatus(now, day);
  putStatus('now', timeInfo.now, timeInfo.nowTime, timeInfo.nowDetail, timeInfo.nowCourse);
  putStatus('next', timeInfo.next, timeInfo.nextTime, timeInfo.nextDetail, timeInfo.nextCourse);
  renderShortcuts();
  renderTimetable();
}

function putStatus(which, title, time, detail, course) {
  $(`#${which}Title`).textContent = title;
  $(`#${which}Time`).textContent = time || '';
  $(`#${which}Subtitle`).textContent = detail || '';
  const link = $(`#${which}Link`);
  const href = activeUrl(course);
  if (href) { link.href = href; link.hidden = false; }
  else { link.removeAttribute('href'); link.hidden = true; }
}

function getSchoolStatus(now, day) {
  if (!day) return { now: 'Weekend', nowDetail: 'Enjoy your time away from class.', next: 'Free / Study', nextDetail: 'Your timetable is ready for the week.' };
  const minute = now.getHours() * 60 + now.getMinutes();
  const minutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const slots = state.timetable[day] || [];
  const courseAt = i => state.courses[slots[i]] || null;
  const timeRange = slot => `${PERIODS[slot].start}–${PERIODS[slot].end}`;
  const showCourse = id => id ? state.courses[id] : null;
  const firstStart = minutes(PERIODS[0].start), lastEnd = minutes(PERIODS.at(-1).end);
  if (minute < firstStart) return { now: 'Before school', nowTime: 'Before P1', nowDetail: 'Classes begin at 9:00 am.', next: courseLabel(courseAt(0)), nextTime: timeRange(0), nextDetail: courseAt(0)?.displayName ? displayYear(courseAt(0).year) : 'Free / Study', nextCourse: courseAt(0) };
  if (minute >= lastEnd) return { now: 'After school', nowTime: 'After P5', nowDetail: 'That’s your school day done.', next: 'Free / Study', nextTime: '', nextDetail: 'Your next school day is coming up.' };
  for (let i = 0; i < PERIODS.length; i++) {
    const start = minutes(PERIODS[i].start), end = minutes(PERIODS[i].end);
    if (minute >= start && minute <= end) {
      const currentCourse = courseAt(i);
      let nextIndex = i + 1;
      if (nextIndex >= PERIODS.length) return { now: courseLabel(currentCourse), nowTime: timeRange(i), nowDetail: displayYear(currentCourse?.year) || 'Current period', nowCourse: currentCourse, next: 'After school', nextTime: 'After P5', nextDetail: 'That’s your school day done.' };
      const nextCourse = courseAt(nextIndex);
      return { now: courseLabel(currentCourse), nowTime: timeRange(i), nowDetail: currentCourse ? `${displayYear(currentCourse.year)} · Period ${i + 1}` : `Period ${i + 1} · Free / Study`, nowCourse: currentCourse, next: courseLabel(nextCourse), nextTime: timeRange(nextIndex), nextDetail: nextCourse ? `${displayYear(nextCourse.year)} · Period ${nextIndex + 1}` : `Period ${nextIndex + 1} · Free / Study`, nextCourse };
    }
  }
  if (minute > minutes(PERIODS[1].end) && minute < minutes(PERIODS[2].start)) {
    return { now: 'Recess', nowTime: '10:55–11:16', nowDetail: 'Take a short break.', next: courseLabel(courseAt(2)), nextTime: timeRange(2), nextDetail: courseAt(2) ? `${displayYear(courseAt(2).year)} · Period 3` : 'Period 3 · Free / Study', nextCourse: courseAt(2) };
  }
  if (minute > minutes(PERIODS[2].end) && minute < minutes(PERIODS[3].start)) {
    return { now: 'Lunch', nowTime: '12:13–13:04', nowDetail: 'Enjoy your lunch break.', next: courseLabel(courseAt(3)), nextTime: timeRange(3), nextDetail: courseAt(3) ? `${displayYear(courseAt(3).year)} · Period 4` : 'Period 4 · Free / Study', nextCourse: courseAt(3) };
  }
  const next = PERIODS.findIndex(period => minute < minutes(period.start));
  const nextIndex = next < 0 ? PERIODS.length - 1 : next;
  return { now: 'Between periods', nowDetail: 'Your next lesson is coming up.', next: courseLabel(courseAt(nextIndex)), nextTime: timeRange(nextIndex), nextDetail: courseAt(nextIndex) ? `${displayYear(courseAt(nextIndex).year)} · Period ${nextIndex + 1}` : `Period ${nextIndex + 1} · Free / Study`, nextCourse: courseAt(nextIndex) };
}

function renderShortcuts() {
  const target = $('#shortcutGrid');
  const courses = (state.shortcuts || []).map(id => state.courses[id]).filter(Boolean);
  if (!courses.length) {
    target.innerHTML = `<div class="empty-subjects"><span>Choose your subjects to add them here.</span><button class="button button-primary button-small" data-open-settings>Choose subjects</button></div>`;
    return;
  }
  target.innerHTML = courses.map(course => {
    const href = activeUrl(course);
    const meta = course.unitURL ? (course.unitTitle || 'Current unit') : 'Course homepage';
    return `<a class="shortcut-card" href="${esc(href || '#')}" target="_blank" rel="noopener noreferrer"><span class="subject-icon">${esc(subjectInitials(course))}</span><span class="shortcut-copy"><span class="shortcut-name">${esc(course.displayName)}</span><span class="shortcut-meta">${esc(meta)}</span></span><span class="shortcut-arrow">↗</span></a>`;
  }).join('');
  bindOpenSettings(target);
}

function renderSettings() {
  if (!state) return;
  const courses = selectedCourses();
  $('#noSubjectsNotice').hidden = courses.length > 0;
  $('#subjectEditorList').innerHTML = courses.map(course => `
    <article class="subject-editor" data-course="${esc(course.id)}">
      <div class="subject-editor-top"><input class="field-input editor-name" data-field="displayName" aria-label="Subject name" value="${esc(course.displayName)}"><span class="course-tag">${esc(displayYear(course.year))}${course.level !== 'Standard' ? ` · ${esc(course.level)}` : ''}</span><button class="icon-text-button" data-remove-course="${esc(course.id)}">Remove</button></div>
      <div class="link-fields">
        <label class="field-group"><span class="field-label">COURSE HOMEPAGE · EDITABLE</span><input class="field-input" data-field="homepageURL" inputmode="url" aria-label="Course homepage URL" placeholder="https://…" value="${esc(course.homepageURL)}"></label>
        <label class="field-group"><span class="field-label">CURRENT UNIT LINK · OPTIONAL</span><input class="field-input" data-field="unitURL" inputmode="url" aria-label="Current unit page URL" placeholder="Leave blank to use the homepage" value="${esc(course.unitURL || '')}"></label>
      </div>
      ${course.unitURL ? `<div class="link-fields title-field"><label class="field-group"><span class="field-label">CURRENT PAGE TITLE</span><input class="field-input" data-field="unitTitle" aria-label="Current unit title" value="${esc(course.unitTitle || 'Custom unit page')}"></label><div class="link-controls"><button class="text-button" data-use-home="${esc(course.id)}">Use homepage</button></div></div>` : `<div class="link-controls"><span class="muted">Finder links and custom URLs remain editable above.</span></div>`}
    </article>`).join('');
  renderTimetable();
  renderShortcutEditor();
}

function renderTimetable() {
  const tables = [$('#timetable'), $('#homeTimetable')].filter(Boolean);
  for (const table of tables) {
    table.tHead.innerHTML = `<tr><th>PERIOD</th>${DAYS.map(day => `<th>${esc(day.slice(0, 3).toUpperCase())}</th>`).join('')}</tr>`;
    table.tBodies[0].innerHTML = PERIODS.map((period, index) => `<tr><td>${period.label}<span class="period-time-cell">${period.start}–${period.end}</span></td>${DAYS.map(day => {
      const course = state.courses[state.timetable[day]?.[index]];
      return `<td><button class="timetable-cell ${course ? '' : 'free'}" data-assign-day="${day}" data-assign-period="${index}"><span>${esc(courseLabel(course))}</span></button></td>`;
    }).join('')}</tr>`).join('');
  }
}

function renderShortcutEditor() {
  const target = $('#shortcutEditor');
  const courses = selectedCourses();
  if (!courses.length) { target.innerHTML = `<span class="muted">Choose subjects first.</span>`; return; }
  const valid = state.shortcuts.filter(id => state.courses[id]);
  target.innerHTML = Array.from({ length: Math.min(6, courses.length) }, (_, index) => {
    const selected = valid[index] || '';
    return `<label class="shortcut-edit-row"><span class="shortcut-edit-index">${index + 1}</span><select class="select-input" data-shortcut-index="${index}" aria-label="Dashboard shortcut ${index + 1}"><option value="">${index < valid.length ? 'Select subject' : 'Add a shortcut'}</option>${courses.map(course => `<option value="${esc(course.id)}" ${course.id === selected ? 'selected' : ''}>${esc(course.displayName)}</option>`).join('')}</select></label>`;
  }).join('');
}

function openPicker(mode) {
  pickerMode = mode;
  pickerSelection = new Set();
  $('#pickerTitle').textContent = mode === 'setup' ? 'Choose your subjects' : 'Add subjects';
  $('#pickerEyebrow').textContent = mode === 'setup' ? 'WELCOME TO PORTAL' : 'SUBJECT CATALOGUE';
  $('#pickerDescription').textContent = mode === 'setup'
    ? 'Select the year, subject and level options you need. You can choose different year levels for different subjects.'
    : 'Choose additional subjects. Your current subjects and timetable will be kept.';
  $('#pickerAction').textContent = mode === 'setup' ? 'Continue' : 'Add subjects';
  $('#pickerSearch').value = '';
  renderPicker();
  if (!$('#pickerDialog').open) $('#pickerDialog').showModal();
}

function renderPicker() {
  const query = norm($('#pickerSearch').value);
  const existing = new Set(Object.values(state?.courses || {}).map(course => `${course.year}|${course.homepageURL}`));
  const rows = offerings.filter(offering => {
    if (pickerMode === 'add' && existing.has(offering.id)) return false;
    const searchable = norm(`${offering.year} year ${offering.name} ${offering.subject} ${offering.level} ${offering.program || ''} ${offering.short}`);
    return !query || query.split(' ').every(term => searchable.includes(term) || (['math', 'maths'].includes(term) && searchable.includes('mathematics')));
  });
  if (!offerings.length) {
    $('#pickerList').innerHTML = `<div class="offer-empty">The subject catalogue did not load. Reload the page or check that subjects.json is beside index.html.</div>`;
  } else if (!rows.length) {
    $('#pickerList').innerHTML = `<div class="offer-empty">No matching subject homepages were found.</div>`;
  } else {
    const years = [...new Set(rows.map(row => row.year))].sort((a,b) => a-b);
    $('#pickerList').innerHTML = years.map(year => `<section class="picker-year"><div class="year-heading">Year ${year}</div>${rows.filter(row => row.year === year).map(offering => `
      <label class="offer-row"><input type="checkbox" value="${esc(offering.id)}" ${pickerSelection.has(offering.id) ? 'checked' : ''}><span class="offer-name">${esc(offering.short)}</span><span class="offer-level">${offering.program ? esc(offering.program) : ''}</span></label>`).join('')}</section>`).join('');
    $$('input[type="checkbox"]', $('#pickerList')).forEach(input => input.addEventListener('change', () => {
      if (input.checked) pickerSelection.add(input.value); else pickerSelection.delete(input.value);
      updatePickerCount();
    }));
  }
  updatePickerCount();
}

function updatePickerCount() {
  const count = pickerSelection.size;
  $('#pickerSelectionCount').textContent = count ? `${count} subject${count === 1 ? '' : 's'} selected` : 'No subjects selected';
  $('#pickerAction').disabled = count === 0;
}

function applyPicker() {
  const selected = offerings.filter(offering => pickerSelection.has(offering.id));
  if (!selected.length) return;
  if (pickerMode === 'setup') state = { courses: {}, timetable: emptyTimetable(), shortcuts: [] };
  for (const offering of selected) {
    if (state.courses[offering.id]) continue;
    state.courses[offering.id] = { id: offering.id, displayName: offering.name, year: offering.year, subject: offering.subject, level: offering.level, program: offering.program || null, homepageURL: offering.home, unitURL: null, unitTitle: 'Unit not set' };
    if (state.shortcuts.length < 6) state.shortcuts.push(offering.id);
  }
  saveState();
  $('#pickerDialog').close();
  renderSettings(); renderDashboard();
  if (pickerMode === 'setup') setView('home');
  else showToast(`Added ${selected.length} subject${selected.length === 1 ? '' : 's'}.`);
}

function openAssign(day, period) {
  assignSlot = { day, period: Number(period) };
  $('#assignTitle').textContent = `${day}, ${PERIODS[assignSlot.period].label}`;
  $('#assignSearch').value = '';
  renderAssignList();
  $('#assignDialog').showModal();
}

function renderAssignList() {
  const query = norm($('#assignSearch').value);
  const terms = query.split(' ').filter(Boolean);
  const courses = selectedCourses().filter(course => {
    if (!terms.length) return true;
    const searchable = norm(`${course.displayName} year ${course.year} ${course.subject} ${course.level}`);
    return terms.every(term => searchable.includes(term) || ((term === 'math' || term === 'maths') && searchable.includes('mathematics')));
  });
  $('#assignList').innerHTML = `<button class="assign-option" data-assign-value=""><span>Free / Study</span><span>Clear this period</span></button>` + courses.map(course => `<button class="assign-option" data-assign-value="${esc(course.id)}"><span>${esc(course.displayName)}</span><span>Year ${course.year} · ${esc(course.level)}</span></button>`).join('');
  if (!courses.length && query) $('#assignList').innerHTML += `<div class="offer-empty">No matching selected subjects.</div>`;
}

function assignValue(value) {
  if (!assignSlot || !state) return;
  state.timetable[assignSlot.day][assignSlot.period] = value;
  saveState(); $('#assignDialog').close(); renderSettings(); renderDashboard();
}

function removeCourse(id) {
  const course = state.courses[id];
  if (!course) return;
  delete state.courses[id];
  state.shortcuts = state.shortcuts.filter(value => value !== id);
  for (const day of DAYS) state.timetable[day] = state.timetable[day].map(value => value === id ? '' : value);
  saveState(); renderSettings(); renderDashboard(); showToast(`${course.displayName} removed.`);
  if (!Object.keys(state.courses).length) openPicker('setup');
}

function saveField(id, field, value) {
  const course = state.courses[id];
  if (!course) return;
  if (field === 'unitURL') {
    const unitURL = safeHttps(value) || null;
    if (unitURL !== course.unitURL) course.unitTitle = unitURL ? 'Custom unit page' : 'Unit not set';
    course.unitURL = unitURL;
  } else if (field === 'unitTitle') course.unitTitle = value.trim() || 'Custom unit page';
  else if (field === 'displayName') course.displayName = value.trim() || 'Subject';
  else if (field === 'homepageURL') course.homepageURL = value.trim();
  saveState(); renderDashboard();
}

function openSaveLink(candidate) {
  pendingCandidate = candidate;
  $('#saveLinkTitle').textContent = `${candidate.t} · ${candidate.u}`;
  const select = $('#saveLinkSubject');
  const courses = selectedCourses();
  select.innerHTML = courses.map(course => `<option value="${esc(course.id)}">${esc(course.displayName)}</option>`).join('');
  $('#confirmSaveLink').disabled = courses.length === 0;
  $('#saveLinkDialog').showModal();
}

function confirmSaveLink() {
  const id = $('#saveLinkSubject').value;
  const course = state?.courses?.[id];
  const url = safeHttps(pendingCandidate?.u);
  if (!course || !url) return;
  course.unitURL = url;
  course.unitTitle = pendingCandidate.t || 'Catalogue page';
  saveState(); $('#saveLinkDialog').close(); renderSettings(); renderDashboard();
  showToast(`Current link set for ${course.displayName}. You can edit it in Subjects & timetable.`);
}

function queryTokens(query) {
  const expanded = query.replace(/\bu\s*([1-4])\b/gi, 'unit $1');
  const tokens = norm(expanded).split(' ').filter(token => token && !IGNORED.has(token) && (token.length > 1 || /^\d+$/.test(token)));
  for (const token of [...tokens]) {
    if (token === 'math' || token === 'maths') tokens.push('mathematics');
    if (token === 'computing') tokens.push('technology');
    if (/^y\d{1,2}$/.test(token)) tokens.push('year', token.slice(1));
  }
  return [...new Set(tokens)];
}

function searchCatalogue(rawQuery, limit = 10) {
  const expanded = rawQuery.replace(/\bu\s*([1-4])\b/gi, 'unit $1');
  const phrase = norm(expanded);
  const tokens = queryTokens(rawQuery);
  if (!phrase && !tokens.length) return [];
  const unit = expanded.match(/\b(?:unit\s*|u\s*)([1-4])\b/i)?.[1];
  const subjectTokens = tokens.filter(token => token !== 'unit' && !/^\d+$/.test(token));
  const results = [];
  for (const record of indexedCatalogue) {
    let score = 0;
    if (phrase) {
      if (record.nt === phrase) score += 180;
      else if (record.nt.includes(phrase)) score += 110;
      if (record.nl.includes(phrase)) score += 90;
      if (record.nu.includes(phrase)) score += 75;
      if (record.ns.includes(phrase)) score += 28;
    }
    let matched = 0, subjectMatches = 0;
    for (const token of tokens) {
      const variants = token === 'math' || token === 'maths' ? [token, 'mathematics'] : token === 'dev' ? ['dev', 'development'] : token === 'tech' ? ['tech', 'technology'] : [token];
      let points = 0;
      for (const variant of variants) {
        if (record.ntWords.includes(variant)) points = Math.max(points, 24);
        else if (record.nlWords.includes(variant)) points = Math.max(points, 22);
        else if (record.slugWords.includes(variant)) points = Math.max(points, 21);
        else if (record.nuWords.includes(variant)) points = Math.max(points, 15);
        else if (record.nsWords.includes(variant)) points = Math.max(points, 7);
        else if (record.npWords.includes(variant)) points = Math.max(points, 3);
        if ([...record.ntWords, ...record.nlWords, ...record.slugWords, ...record.nuWords].includes(variant)) subjectMatches++;
      }
      if (points) { matched++; score += points; }
    }
    if (tokens.length) {
      if (!matched) continue;
      score += Math.round((matched / tokens.length) * 34);
      if (matched < Math.max(1, Math.floor(tokens.length / 3))) score -= 18;
    }
    if (unit && subjectTokens.length && record.u.toLowerCase().endsWith(`/unit-${unit}`) && subjectMatches >= subjectTokens.length) score += 220;
    if (score > 0) results.push({ record, score });
  }
  results.sort((a, b) => b.score - a.score || a.record.t.localeCompare(b.record.t) || a.record.u.localeCompare(b.record.u));
  return results.slice(0, limit).map(entry => entry.record);
}

function renderFinderResults(query) {
  const target = $('#finderResults');
  const empty = $('#finderEmpty');
  if (!query.trim()) { target.innerHTML = ''; $('#resultCount').textContent = ''; empty.hidden = true; return; }
  const found = searchCatalogue(query, 10);
  $('#resultCount').textContent = found.length ? `${found.length} result${found.length === 1 ? '' : 's'}` : '0 results';
  empty.hidden = found.length > 0;
  if (!found.length) { target.innerHTML = ''; return; }
  target.innerHTML = found.map((record, index) => {
    const context = record.s.slice(0, 2).join(' · ');
    return `<article class="result-card"><div><div class="result-rank">MATCH ${String(index + 1).padStart(2, '0')}</div><h2 class="result-title">${esc(record.t)}</h2><p class="result-context">${esc(context || 'APC Portal catalogue')}</p><p class="result-url">${esc(record.u)}</p></div><div class="result-actions"><button class="button button-secondary" data-set-candidate="${index}">Set current</button><a class="button button-primary" href="${esc(record.u)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div></article>`;
  }).join('');
  $$('#finderResults [data-set-candidate]').forEach(button => button.addEventListener('click', () => openSaveLink(found[Number(button.dataset.setCandidate)])));
}

function bindOpenSettings(root = document) {
  $$('[data-open-settings]', root).forEach(button => button.addEventListener('click', () => setView('settings')));
}

function exportTimetableCalendar() {
  if (!state) return showToast('Choose subjects and add them to your weekly timetable first.');
  const calendar = window.PortalCalendar.createCalendar(state);
  if (!calendar.eventCount) return showToast('Assign at least one class period before adding your timetable to Calendar.');
  const blob = new Blob([calendar.content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const download = document.createElement('a');
  download.href = url;
  download.download = `Portal-Timetable-${new Date().toISOString().slice(0, 10)}.ics`;
  download.hidden = true;
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${calendar.eventCount} weekly class${calendar.eventCount === 1 ? '' : 'es'}. Open the .ics file to add it to Calendar; school holidays are not excluded.`);
}

function isRunningAsInstalledApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function showInstallInstructions() {
  if (isRunningAsInstalledApp()) return showToast('Portal is already open from your Home Screen.');
  $('#installDialog').showModal();
}

function registerOfflineApp() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('service-worker.js').catch(error => {
    console.warn('Portal offline support could not be enabled.', error);
  });
}

function setupEvents() {
  $('#themeToggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
  });
  $$('.nav-button, [data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  bindOpenSettings();
  $('#pickerSearch').addEventListener('input', renderPicker);
  $('#pickerDialog').addEventListener('cancel', event => { if (pickerMode === 'setup' && !state) event.preventDefault(); });
  $('#pickerAction').addEventListener('click', applyPicker);
  $('#addSubjectButton').addEventListener('click', () => openPicker('add'));
  $('#subjectEditorList').addEventListener('input', event => {
    const field = event.target.dataset.field;
    const editor = event.target.closest('[data-course]');
    if (field && editor) saveField(editor.dataset.course, field, event.target.value);
  });
  $('#subjectEditorList').addEventListener('change', event => {
    if (event.target.dataset.field === 'unitURL') renderSettings();
  });
  $('#subjectEditorList').addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-course]');
    if (remove) removeCourse(remove.dataset.removeCourse);
    const home = event.target.closest('[data-use-home]');
    if (home) { const course = state.courses[home.dataset.useHome]; course.unitURL = null; course.unitTitle = 'Unit not set'; saveState(); renderSettings(); renderDashboard(); showToast('Using the course homepage again.'); }
  });
  [$('#timetable'), $('#homeTimetable')].filter(Boolean).forEach(table => table.addEventListener('click', event => {
    const cell = event.target.closest('[data-assign-day]');
    if (cell) openAssign(cell.dataset.assignDay, cell.dataset.assignPeriod);
  }));
  $('#assignSearch').addEventListener('input', renderAssignList);
  $('#assignList').addEventListener('click', event => {
    const option = event.target.closest('[data-assign-value]');
    if (option) assignValue(option.dataset.assignValue);
  });
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
  $('#shortcutEditor').addEventListener('change', event => {
    if (event.target.matches('[data-shortcut-index]')) {
      const index = Number(event.target.dataset.shortcutIndex), value = event.target.value;
      const others = state.shortcuts.filter((_, i) => i !== index);
      if (value && !others.includes(value)) state.shortcuts[index] = value;
      else if (!value) state.shortcuts.splice(index, 1);
      else { showToast('A subject can appear in one shortcut at a time.'); renderShortcutEditor(); return; }
      state.shortcuts = state.shortcuts.filter(Boolean).slice(0, 6); saveState(); renderShortcutEditor(); renderDashboard();
    }
  });
  $('#finderForm').addEventListener('submit', event => { event.preventDefault(); renderFinderResults($('#finderQuery').value); });
  $('#finderQuery').addEventListener('input', () => { clearTimeout(finderTimer); finderTimer = setTimeout(() => renderFinderResults($('#finderQuery').value), 180); });
  $('#confirmSaveLink').addEventListener('click', confirmSaveLink);
  $('#exportCalendarButton').addEventListener('click', exportTimetableCalendar);
  $('#exportCalendarSettingsButton').addEventListener('click', exportTimetableCalendar);
  $('#installAppButton').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return showInstallInstructions();
    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      showToast(choice?.outcome === 'accepted' ? 'Portal has been added to your Home Screen.' : 'Choose Add to Home Screen from the browser menu when you are ready.');
    } catch {
      showInstallInstructions();
    }
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const label = $('#installAppButton span');
    if (label) label.textContent = 'Install Portal';
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    $('#installAppButton').hidden = true;
    showToast('Portal was added to your Home Screen.');
  });
  $('#resetButton').addEventListener('click', () => $('#resetDialog').showModal());
  $('#confirmReset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY); state = null; $('#resetDialog').close(); openPicker('setup'); renderSettings(); renderDashboard();
  });
}

async function loadData() {
  $('#catalogStatus').textContent = 'Loading catalogue…';
  try {
    const [catalogResponse, subjectsResponse] = await Promise.all([fetch('catalogue.json'), fetch('subjects.json')]);
    if (!catalogResponse.ok || !subjectsResponse.ok) throw new Error('The catalogue data files could not be read.');
    if ('caches' in window) {
      try {
        const offlineData = await caches.open(OFFLINE_DATA_CACHE);
        await Promise.all([
          offlineData.put(new URL('catalogue.json', document.baseURI), catalogResponse.clone()),
          offlineData.put(new URL('subjects.json', document.baseURI), subjectsResponse.clone())
        ]);
      } catch (error) {
        console.warn('Portal catalogue could not be saved for offline use.', error);
      }
    }
    const catalogData = await catalogResponse.json();
    offerings = await subjectsResponse.json();
    catalogue = catalogData.candidates || [];
    indexedCatalogue = catalogue.map(record => {
      const title = norm(record.t), labels = norm((record.l || []).join(' ')), sources = norm((record.s || []).join(' '));
      const urlText = norm(record.u.replace(/[-/]/g, ' '));
      const slug = norm(record.u.split('/').slice(-4).join(' ').replace(/[-_]/g, ' '));
      const pages = norm((record.p || []).join(' '));
      return { ...record, nt: title, nl: labels, ns: sources, nu: urlText, np: pages, slug, ntWords: title.split(' '), nlWords: labels.split(' '), nsWords: sources.split(' '), npWords: pages.split(' '), nuWords: urlText.split(' '), slugWords: slug.split(' ') };
    });
    $('#catalogStatus').textContent = `${catalogue.length.toLocaleString()} destinations indexed`;
    $('#snapshotSummary').textContent = `${catalogData.pages.toLocaleString()} pages · ${catalogData.links.toLocaleString()} links`;
  } catch (error) {
    console.error(error);
    $('#catalogStatus').textContent = 'Catalogue unavailable';
    $('#snapshotSummary').textContent = 'Catalogue data could not be loaded';
    $('#finderMessage').textContent = location.protocol === 'file:'
      ? 'Start the included web server first. Browsers cannot load the subject and link catalogues by opening index.html directly.'
      : 'Check that catalogue.json and subjects.json are present beside index.html and served from this folder.';
  }
}

async function init() {
  setTheme(document.documentElement.dataset.theme || 'dark');
  setupEvents();
  registerOfflineApp();
  try { state = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); } catch { state = null; }
  await loadData();
  const now = new Date();
  $('#todayDate').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (!state) openPicker('setup');
  else { renderDashboard(); renderSettings(); }
  if (!catalogue.length) $('#finderResults').innerHTML = '';
  window.setInterval(() => { if (state) renderDashboard(); }, 60_000);
}

init();
