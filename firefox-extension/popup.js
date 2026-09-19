const $ = id => document.getElementById(id);

let config = {};
let tab = null;
let categories = []; // [{id, name, color}]
let meta = {};

async function init() {
  config = await browser.storage.local.get(['serverUrl', 'uuid']);
  $('open-settings').addEventListener('click', () => browser.runtime.openOptionsPage());

  if (!config.serverUrl || !config.uuid) {
    $('not-configured').style.display = 'flex';
    $('go-settings').addEventListener('click', () => browser.runtime.openOptionsPage());
    return;
  }

  $('main').style.display = 'flex';
  $('main').addEventListener('submit', save);

  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  showUrl(tab.url);
  if (tab.favIconUrl) {
    const img = $('favicon');
    img.src = tab.favIconUrl;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  }
  // the tab already knows its title; the scrape below only fills in what it can't
  $('title').value = tab.title || '';

  const [metaRes, tagsRes] = await Promise.all([
    api(`/api/metadata/preview?url=${encodeURIComponent(tab.url)}`),
    api('/api/tags'),
  ]);
  if (tagsRes?.status === 401) { showStatus('Invalid API key — check Settings.', 'error'); return; }
  if (metaRes?.ok) {
    meta = await metaRes.json();
    if (!$('title').value) $('title').value = meta.title || '';
    $('desc').value = meta.description || '';
  }
  if (tagsRes?.ok) {
    categories = (await tagsRes.json()).filter(t => t.id !== '__new__');
    for (const t of categories) $('category').append(new Option(t.name, t.id));
  }
}

function showUrl(url) {
  try {
    const u = new URL(url);
    $('page-url').textContent = u.hostname + u.pathname.replace(/\/$/, '');
  } catch {
    $('page-url').textContent = url;
  }
}

function api(path, opts = {}) {
  return fetch(config.serverUrl + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Tether-UUID': config.uuid },
  }).catch(() => null);
}

async function save(e) {
  e.preventDefault();
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  hideStatus();

  const title = $('title').value.trim();
  const catId = $('category').value;
  const cat = categories.find(t => String(t.id) === catId);

  try {
    const res = await api('/api/links', {
      method: 'POST',
      body: JSON.stringify({
        url: tab.url,
        title,
        description: $('desc').value.trim(),
        favicon_url: meta.favicon_url || tab.favIconUrl || '',
        tags: cat ? [cat.name] : [],
      }),
    });
    if (!res) throw new Error('could not reach server');
    if (res.status === 401) {
      showStatus('Invalid API key — check Settings.', 'error');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const noteText = $('note').value.trim();
    if (noteText && data.id && !data.duplicate) {
      // same two-step the web modal does: create, then fill in the body
      const noteRes = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: title || new URL(tab.url).hostname, link_id: data.id, tag_id: Number(catId) || null }),
      });
      if (noteRes?.ok) {
        const note = await noteRes.json();
        await api(`/api/notes/${note.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: `${tab.url}\n\n${noteText}` }),
        });
      }
    }

    showStatus(data.duplicate ? 'Already saved.' : 'Saved!', data.duplicate ? 'info' : 'success');
    btn.textContent = 'Saved';
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Save';
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

init();
