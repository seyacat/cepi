// PWA install prompt
let deferredPrompt = null;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBtn.hidden = true;
  deferredPrompt = null;
});

window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// Chat
const scrollArea = document.getElementById('scroll-area');
const messagesEl = document.getElementById('messages');
const form       = document.getElementById('chat-form');
const input      = document.getElementById('input');
const sendBtn    = form.querySelector('button[type="submit"]');
const history    = [];

// ── Renderizado de mensajes ───────────────────────────────────────────────────
function addMessage(role, text = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollArea.scrollTop = scrollArea.scrollHeight;
  return div;
}

// Renderiza botones del árbol de decisión
function renderButtons(buttons) {
  // Eliminar botones anteriores si los hay
  const old = messagesEl.querySelector('.btn-group');
  if (old) old.remove();

  const group = document.createElement('div');
  group.className = 'btn-group';

  buttons.forEach((btn) => {
    const b = document.createElement('button');
    b.className = 'tree-btn';
    b.textContent = btn.label;
    b.dataset.action = btn.id;

    b.addEventListener('click', () => {
      // Acciones especiales (links externos)
      if (btn.id === 'cita_online') return window.open('https://cepi.ec', '_blank');
      if (btn.id === 'login_portal') return window.open('https://cepi.ec', '_blank');
      if (btn.id === 'cita_whatsapp') return window.open('https://wa.me/593XXXXXXXXX', '_blank');

      // Enviar como mensaje de usuario
      group.remove();
      sendUserMessage(btn.label);
    });

    group.appendChild(b);
  });

  messagesEl.appendChild(group);
  scrollArea.scrollTop = scrollArea.scrollHeight;
}

// ── Envío de mensajes ─────────────────────────────────────────────────────────
async function sendUserMessage(text) {
  if (!text) return;
  sendBtn.disabled = true;

  addMessage('user', text);
  history.push({ role: 'user', content: text });

  const botDiv = addMessage('bot');
  botDiv.classList.add('streaming');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let reply = '';
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;
        try {
          const { content, error, status, buttons } = JSON.parse(payload);
          if (status) {
            botDiv.dataset.status = status;
            botDiv.textContent = status;
          } else if (error) {
            reply += `[Error: ${error}]`;
            botDiv.textContent = reply;
          } else if (content) {
            delete botDiv.dataset.status;
            reply += content;
            botDiv.textContent = reply;
          } else if (buttons) {
            renderButtons(buttons);
          }
          scrollArea.scrollTop = scrollArea.scrollHeight;
        } catch {}
      }
    }

    if (reply) history.push({ role: 'assistant', content: reply });
  } catch (err) {
    botDiv.textContent = `Error de conexión: ${err.message}`;
  } finally {
    botDiv.classList.remove('streaming');
    if (!botDiv.textContent) botDiv.remove(); // quitar burbuja vacía
    sendBtn.disabled = false;
    input.focus();
  }
}

// ── Menú inicial al cargar ────────────────────────────────────────────────────
const MENU_INICIAL = [
  { id: 'consulta', label: '📋 Consulta dermatológica' },
  { id: 'cita',     label: '📅 Agendar una cita' },
  { id: 'buscar',   label: '🔍 Buscar información' },
  { id: 'login',    label: '🔐 Acceso al sistema' },
  { id: 'otro',     label: '💬 Otra consulta' },
];
renderButtons(MENU_INICIAL);

// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  sendUserMessage(text);
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
