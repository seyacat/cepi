// Stub de `firebase/messaging` para el BUNDLE.
// El web-impl de @capacitor-firebase/messaging importa el firebase JS SDK, pero
// nunca se ejecuta: en web usamos Web Push (VAPID) y en nativo el plugin usa el
// bridge nativo (no este web-impl). Este stub evita arrastrar el SDK de firebase
// al bundle. isSupported()=false hace que el web-impl salga temprano si se
// instanciara.
export const isSupported = async () => false;
export const getMessaging = () => { throw new Error('firebase/messaging no disponible en este build'); };
export const getToken = async () => { throw new Error('firebase/messaging stub'); };
export const deleteToken = async () => {};
export const onMessage = () => () => {};
