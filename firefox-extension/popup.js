const $ = id => document.getElementById(id);

let allTags = [];
let selectedTags = new Set(); // tag names
let config = {};
let activeIndex = -1;

async function init() {
  const stored = await browser.storage.local.get(['serverUrl', 'uuid']);
  config = stored;

  if (!config.serverUrl || !config.uuid) {
    $('not-configured').style.display = 'flex';
    $('go-settings').addEventListener('click', () => browser.runtime.openOptionsPage());
    $('open-settings').addEventListener('click', () => browser.runtime.openOptionsPage());
    return;
  }

  $('main').style.display = 'block';
  $('open-settings').addEventListener('click', () => browser.runtime.openOptionsPage());

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  showUrl(tab.url);
  if (tab.favIconUrl) {
    const img = $('favicon');
    img.src = tab.favIconUrl;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  }

  await loadTags();
  setupTagInput();

  $('save-btn').addEventListener('click', save);
}

function showUrl(url) {
  try {
    const u = new URL(url);
    $('page-url').textContent = u.hostname + u.pathname.replace(/\/$/, '');
  } catch {
    $('page-url').textContent = url;
  }
}

async function loadTags() {
  try {
    const res = await fetch(`${config.serverUrl}/api/tags?shortcut=true`, {
      headers: { 'X-Tether-UUID': config.uuid }
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    allTags = data.filter(t => t.id !== '__new__');
  } catch {
    // non-fatal; user can still save without tags
  }
}

function setupTagInput() {
  const input = $('tag-search');
  const dropdown = $('tag-dropdown');
  const wrap = $('tag-input-wrap');

  wrap.addEventListener('click', () => input.focus());

  input.addEventListener('input', () => {
    renderDropdown(input.value.trim());
  });

  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('.dropdown-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        items[activeIndex].click();
      } else if (input.value.trim()) {
        selectTag(input.value.trim());
        input.value = '';
        hideDropdown();
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
      input.blur();
    } else if (e.key === 'Backspace' && input.value === '') {
      const last = [...selectedTags].pop();
      if (last) removeTag(last);
    }
  });

  input.addEventListener('focus', () => renderDropdown(input.value.trim()));
  input.addEventListener('blur', () => setTimeout(hideDropdown, 150));
}

function updateActive(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
}

function renderDropdown(query) {
  const dropdown = $('tag-dropdown');
  activeIndex = -1;
  const q = query.toLowerCase();

  const filtered = allTags.filter(t =>
    !selectedTags.has(t.name) && t.name.toLowerCase().includes(q)
  );

  dropdown.innerHTML = '';

  if (filtered.length === 0 && !query) {
    if (selectedTags.size === allTags.length && allTags.length > 0) {
      dropdown.innerHTML = '<div class="dropdown-empty">All tags selected</div>';
    } else if (allTags.length === 0) {
      dropdown.innerHTML = '<div class="dropdown-empty">No tags yet</div>';
    } else {
      hideDropdown(); return;
    }
  } else {
    filtered.forEach(tag => {
      const el = document.createElement('div');
      el.className = 'dropdown-item';
      el.innerHTML = `
        <span class="dropdown-dot" style="background:${tag.color}"></span>
        <span class="dropdown-name">${escHtml(tag.name)}</span>
      `;
      el.addEventListener('mousedown', e => { e.preventDefault(); selectTag(tag.name); $('tag-search').value = ''; hideDropdown(); });
      dropdown.appendChild(el);
    });

    if (query && !allTags.find(t => t.name.toLowerCase() === q)) {
      const el = document.createElement('div');
      el.className = 'dropdown-item';
      el.innerHTML = `<span class="dropdown-create">Create "${escHtml(query)}"</span>`;
      el.addEventListener('mousedown', e => { e.preventDefault(); selectTag(query); $('tag-search').value = ''; hideDropdown(); });
      dropdown.appendChild(el);
    }
  }

  dropdown.style.display = 'block';
}

function hideDropdown() {
  $('tag-dropdown').style.display = 'none';
}

function selectTag(name) {
  selectedTags.add(name);
  renderChips();
}

function removeTag(name) {
  selectedTags.delete(name);
  renderChips();
}

function renderChips() {
  const container = $('selected-tags');
  container.innerHTML = '';
  for (const name of selectedTags) {
    const tag = allTags.find(t => t.name === name);
    const color = tag ? tag.color : '#6366f1';
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `
      <span class="tag-chip-dot" style="background:${color}"></span>
      ${escHtml(name)}
      <button class="tag-chip-remove" data-name="${escAttr(name)}" title="Remove">×</button>
    `;
    chip.querySelector('.tag-chip-remove').addEventListener('click', () => removeTag(name));
    container.appendChild(chip);
  }
}

async function save() {
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  hideStatus();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  try {
    const res = await fetch(`${config.serverUrl}/api/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-UUID': config.uuid
      },
      body: JSON.stringify({ url: tab.url, tags: [...selectedTags] })
    });

    if (res.status === 401) {
      showStatus('Invalid API key — check Settings.', 'error');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.duplicate) {
      showStatus('Already saved.', 'info');
    } else {
      showStatus('Saved!', 'success');
    }

    btn.textContent = 'Saved';
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Save link';
  }
}

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${type}`;
  el.style.display = 'block';
}

function hideStatus() {
  $('status').style.display = 'none';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return s.replace(/"/g, '&quot;');
}

init();
