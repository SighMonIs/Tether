const $ = id => document.getElementById(id);

async function init() {
  const stored = await browser.storage.local.get(['serverUrl', 'uuid']);
  if (stored.serverUrl) $('server-url').value = stored.serverUrl;
  if (stored.uuid)      $('uuid').value      = stored.uuid;

  $('save-btn').addEventListener('click', save);
  $('test-btn').addEventListener('click', test);
  $('toggle-uuid').addEventListener('click', () => {
    const input = $('uuid');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

async function save() {
  const serverUrl = $('server-url').value.trim().replace(/\/$/, '');
  const uuid      = $('uuid').value.trim();

  if (!serverUrl || !uuid) {
    showStatus('Both fields are required.', 'error');
    return;
  }

  await browser.storage.local.set({ serverUrl, uuid });
  showStatus('Settings saved.', 'success');
}

async function test() {
  const serverUrl = $('server-url').value.trim().replace(/\/$/, '');
  const uuid      = $('uuid').value.trim();

  if (!serverUrl || !uuid) {
    showStatus('Enter the server URL and API key first.', 'error');
    return;
  }

  showStatus('Testing…', 'info');

  try {
    const res = await fetch(`${serverUrl}/api/tags?shortcut=true`, {
      headers: { 'X-Tether-UUID': uuid }
    });

    if (res.status === 401) {
      showStatus('Connection failed — invalid API key.', 'error');
    } else if (!res.ok) {
      showStatus(`Connection failed — server returned ${res.status}.`, 'error');
    } else {
      const tags = await res.json();
      const count = tags.filter(t => t.id !== '__new__').length;
      showStatus(`Connected! ${count} tag${count !== 1 ? 's' : ''} found.`, 'success');
    }
  } catch (err) {
    showStatus(`Could not reach server: ${err.message}`, 'error');
  }
}

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${type}`;
  el.style.display = 'block';
}

init();
