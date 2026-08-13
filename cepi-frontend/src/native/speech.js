// Dictado (STT). Una sola API para los dos entornos:
//   - Nativo (Android/iOS): @capgo/capacitor-speech-recognition → motor del SO.
//   - Web: Web Speech API (webkitSpeechRecognition en Chrome).
//
// El consumidor recibe texto por callbacks y no sabe cuál de los dos corre.
// El import del plugin es dinámico para no arrastrarlo al bundle web.
import { Capacitor } from '@capacitor/core';

// Se prefiere el locale del dispositivo cuando ya es español: es el único que
// con seguridad tiene el pack de reconocimiento instalado. Pedir una variante
// que el motor no tenga bajada (es-EC en un teléfono en es-US, por ejemplo)
// hace que falle o se vaya a la red sin avisar.
const LANG = (() => {
  const sys = typeof navigator !== 'undefined' ? (navigator.language || '') : '';
  return /^es\b/i.test(sys) ? sys : 'es-EC';
})();

const native = Capacitor.getPlatform() !== 'web';

// ── Nativo ──────────────────────────────────────────────────────────────────
let pluginPromise = null;
function loadPlugin() {
  if (!pluginPromise) {
    // OJO: la promesa NO puede resolver con el plugin directamente. El proxy de
    // Capacitor intercepta cualquier acceso a propiedad, `then` incluido, así
    // que `await plugin` lo toma por thenable y llama a un `then()` nativo que
    // no existe → "SpeechRecognition.then() is not implemented on android", y
    // el await se cuelga para siempre. Va envuelto en un objeto plano.
    pluginPromise = import('@capgo/capacitor-speech-recognition')
      .then(m => ({ plugin: m.SpeechRecognition }));
  }
  return pluginPromise;
}

// NO usar SpeechRecognition.isOnDeviceRecognitionAvailable(): el plugin (8.1.10)
// llama createOnDeviceSpeechRecognizer fuera del hilo principal y Android tira
// "SpeechRecognizer should be used only from the application's main thread",
// que llega como FATAL EXCEPTION y tumba la app entera.
//
// Por eso tampoco pedimos useOnDeviceRecognition: ese flag entra al mismo camino.
// No se pierde nada real — el recognizer por defecto de Android ya resuelve
// on-device cuando el motor lo soporta (acá es Android System Intelligence).

function nativeSession({ onPartial, onFinal, onEnd, onError }, { continuous }) {
  let handles = [];
  let stopped = false;
  let held = false;      // "botón PTT apretado" = el usuario sigue dictando
  let last = '';

  const emit = (text) => {
    if (typeof text !== 'string') return;
    last = text;
    onPartial(text);
  };

  return {
    async start() {
      const { plugin: SpeechRecognition } = await loadPlugin();

      let perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== 'granted') {
        perm = await SpeechRecognition.requestPermissions();
      }
      if (perm.speechRecognition !== 'granted') {
        throw new Error('Necesito permiso de micrófono para dictar.');
      }

      const { available } = await SpeechRecognition.available();
      if (!available) {
        throw new Error('Este dispositivo no tiene reconocimiento de voz disponible.');
      }


      handles = await Promise.all([
        SpeechRecognition.addListener('partialResults', (ev) => {
          // El evento parte el texto en dos: `accumulated` es lo cerrado en
          // tramos anteriores (el motor rearranca en cada pausa) y `matches[0]`
          // es el tramo en curso. Hay que unirlos: quedarse con matches pierde
          // todo lo dicho antes de la última pausa.
          // Excepción: en `isRestarting` el plugin ya plegó el tramo dentro de
          // `accumulated`, y sumarlo lo duplicaría.
          if (typeof ev?.accumulatedText === 'string') { emit(ev.accumulatedText); return; }
          const acc = ev?.accumulated ?? '';
          const cur = ev?.isRestarting ? '' : (ev?.matches?.[0] ?? '');
          emit([acc, cur].filter(Boolean).join(' '));
        }),
        SpeechRecognition.addListener('listeningState', (ev) => {
          const state = ev?.state ?? ev?.status;
          if (state !== 'stopped' || stopped) return;
          // En modo continuo el motor para y rearranca solo en cada pausa. Esos
          // "stopped" NO son el fin del dictado: mientras el usuario no toque el
          // botón (held), se ignoran y el plugin reanuda.
          const reason = ev?.reason;
          if (held && (reason === 'silence' || reason === 'results')) return;
          stopped = true;
          onFinal(last);
          onEnd();
        }),
        SpeechRecognition.addListener('error', (ev) => {
          // "no match"/"speech timeout" son ruido normal de una pausa larga, no
          // errores que valga la pena mostrarle al médico.
          const code = String(ev?.code ?? '');
          if (/no.?match|timeout/i.test(code)) return;
          onError(new Error(ev?.message || 'Falló el reconocimiento de voz.'));
        }),
      ]);

      await SpeechRecognition.start({
        language: LANG,
        partialResults: true,
        popup: false,                  // inline, sin el diálogo del sistema
        // Continuo: reanuda tras cada pausa, para dictar párrafos largos.
        // No continuo: la sesión cierra sola al detectar el fin de la frase,
        // que es lo que permite el envío automático sin tocar nada.
        continuousPTT: continuous,
        allowForSilence: 4000,         // menos cortes = menos reinicios
        // El "supresor de beep" del plugin silencia y restaura el stream de
        // notificaciones del sistema en CADA reinicio; con dictado continuo eso
        // es el modo silencio prendiéndose y apagándose sin parar. Preferimos
        // oír el beep antes que manosear el volumen del teléfono.
        muteRecognizerBeep: false,
      });

      if (!continuous) return;
      // continuousPTT se apoya en este estado para saber si debe reanudar.
      held = true;
      try { await SpeechRecognition.setPTTState({ held: true, mute: false }); }
      catch { /* versiones viejas del plugin no lo traen */ }
    },

    async stop() {
      if (stopped) return;
      const { plugin: SpeechRecognition } = await loadPlugin();
      held = false;
      try { await SpeechRecognition.setPTTState({ held: false }); } catch { /* opcional */ }
      try {
        // forceStop devuelve lo último que el motor tenga en el buffer; stop()
        // a secas puede perder el tramo en curso.
        await SpeechRecognition.forceStop();
      } catch {
        try { await SpeechRecognition.stop(); } catch { /* ya estaba parado */ }
      }
      try {
        const r = await SpeechRecognition.getLastPartialResult();
        if (r?.available && r.text) last = r.text;
      } catch { /* opcional */ }
      if (!stopped) { stopped = true; onFinal(last); onEnd(); }
    },

    dispose() {
      handles.forEach(h => { try { h.remove(); } catch { /* noop */ } });
      handles = [];
    },
  };
}

// ── Web ─────────────────────────────────────────────────────────────────────
function webCtor() {
  return typeof window === 'undefined'
    ? null
    : (window.SpeechRecognition || window.webkitSpeechRecognition || null);
}

function webSession({ onPartial, onFinal, onEnd, onError }, { continuous }) {
  const Ctor = webCtor();
  let rec = null;
  let settled = false;
  let committed = '';   // tramos ya marcados como finales por el motor

  const finish = (text) => {
    if (settled) return;
    settled = true;
    onFinal(text);
    onEnd();
  };

  return {
    async start() {
      if (!Ctor) throw new Error('Este navegador no soporta dictado por voz.');
      rec = new Ctor();
      rec.lang = LANG;
      rec.continuous = continuous;   // false: corta al fin de la frase y se envía
      rec.interimResults = true;

      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) committed += r[0].transcript;
          else interim += r[0].transcript;
        }
        onPartial((committed + interim).trim());
      };
      rec.onerror = (ev) => {
        if (ev.error === 'aborted' || ev.error === 'no-speech') return;
        onError(new Error(
          ev.error === 'not-allowed'
            ? 'Necesito permiso de micrófono para dictar.'
            : 'Falló el reconocimiento de voz.'
        ));
        finish(committed.trim());
      };
      rec.onend = () => finish(committed.trim());
      rec.start();
    },

    async stop() {
      try { rec?.stop(); } catch { /* ya estaba parado */ }
    },

    dispose() {
      if (!rec) return;
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* noop */ }
      rec = null;
    },
  };
}

// ── API pública ─────────────────────────────────────────────────────────────

/** ¿Hay alguna vía de dictado en este entorno? En nativo se confirma al arrancar. */
export const dictationSupported = native || !!webCtor();

/**
 * Crea una sesión de dictado.
 *  onPartial(texto)  — texto acumulado de la sesión, se reemplaza en cada evento
 *  onFinal(texto)    — texto definitivo al cerrar
 *  onEnd()           — la sesión terminó (por stop, silencio o error)
 *  onError(err)      — error mostrable al usuario
 *
 * `continuous` (default true): mantener la escucha a través de las pausas. En
 * false la sesión cierra sola al terminar la frase — es el modo que usa el
 * envío automático.
 */
export function createDictation(handlers, { continuous = true } = {}) {
  const h = {
    onPartial: () => {},
    onFinal: () => {},
    onEnd: () => {},
    onError: () => {},
    ...handlers,
  };
  const opts = { continuous };
  return native ? nativeSession(h, opts) : webSession(h, opts);
}
