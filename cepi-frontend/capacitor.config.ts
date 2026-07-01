import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ec.cepi.telemedicina',
  appName: 'CEPI Telemedicina',
  webDir: 'dist',
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0f172a',
      showSpinner: false,
    },
    // OTA (Capgo, self-hosted): en cada arranque consulta updateUrl; si hay una
    // versión nueva del layer web la descarga y la aplica en el próximo resume.
    // El server sirve un manifest JSON + un zip del build (ver NATIVE.md §OTA).
    CapacitorUpdater: {
      autoUpdate: true,
      updateUrl: 'https://telemedicina.cepi.ec/api/ota/latest',
      // Al instalar una nueva versión NATIVA (store) descarta el bundle OTA
      // viejo y usa el empaquetado.
      resetWhenUpdate: true,
    },
  },
};

export default config;
