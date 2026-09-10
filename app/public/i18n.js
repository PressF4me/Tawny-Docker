/*
 * Tiny i18n for the in-call web UI. Loaded before app.js (a classic script, so
 * it runs before the deferred module). The native shell passes the resolved
 * language tag into window.tawnyStart(opts.lang); TawnyT.set() switches to it.
 *
 * Add a language: add its map under DICT and a <locale> in the app's
 * locales_config.xml so the shell offers it. Keys mirror the Android
 * strings.xml naming where the same text exists on both sides.
 */
(function () {
  'use strict';

  const DICT = {
    en: {
      // --- live controls (static markup) ---
      w_ctl_chime: 'Chime',
      w_ctl_light: 'Light',
      w_ctl_my_camera: 'My camera',
      w_ctl_snapshot: 'Snapshot',
      w_ctl_record: 'Record',
      w_ctl_hang_up: 'Hang up',
      w_ctl_flip_camera: 'Flip camera',
      w_ctl_mute_mic: 'Mute mic',
      w_ctl_dim_screen: 'Dim screen',
      w_ctl_end_call: 'End call',
      // --- chimes ---
      w_chime_bark: 'Dog toy',
      w_chime_pspsps: 'Psp psp psp',
      w_chime_meow: 'Meow',
      w_chime_goodboy: 'Good boy',
      w_chime_bell: 'Bell',
      // --- rail / talk / a11y ---
      w_aria_connecting: 'Connecting',
      w_aria_sound_level: 'Sound level at the far end',
      w_aria_phones_watching: 'Phones watching',
      w_listening_to_you: 'Listening to you',
      w_hold_to_talk: 'Hold to talk',
      // --- status() ---
      w_status_connecting: 'Connecting',
      w_status_live: 'Live',
      w_status_on_air: 'On air',
      w_status_waiting: 'Waiting',
      w_status_monitor_paused: 'Monitor paused',
      w_status_monitor_offline: 'Monitor offline',
      w_status_reconnecting: 'Reconnecting',
      w_status_paused_screen_off: 'Paused — screen off',
      w_status_paused_tap_resume: 'Paused — tap to resume',
      w_status_still_trying: 'Still trying',
      w_status_call_ended: 'Call ended',
      // --- toasts ---
      w_toast_reconnecting: 'Reconnecting…',
      w_toast_taken_over: 'This monitor was taken over by another device.',
      w_toast_another_phone: 'Another phone is now using this monitor.',
      w_toast_wifi_only: 'This monitor can only be watched from your Wi-Fi right now. Phones somewhere else will not be able to connect.',
      w_toast_own_server_failed: 'Your own server did not answer. Using Tawny’s relay instead.',
      w_toast_light_off_battery: 'Light turned off to save the battery.',
      w_toast_could_not_switch_lens: 'Could not switch lens.',
      w_toast_could_not_switch_camera: 'Could not switch camera.',
      w_toast_no_monitor_connected: 'No monitor connected yet.',
      w_toast_start_call_first: 'Start a call first.',
      w_toast_could_not_open_camera: 'Could not open your camera.',
      w_toast_nothing_to_capture: 'Nothing to capture yet.',
      w_toast_snapshot_saved: 'Snapshot saved',
      w_toast_video_not_supported: 'Video recording is not supported here.',
      w_toast_video_saved: 'Video saved',
      w_toast_link_copied: 'Link copied',
      // --- stage notes ---
      w_note_monitor_paused_title: 'The monitor is paused',
      w_note_monitor_paused_body: 'Its screen turned off or the app moved to the background. The picture comes back on its own when the monitor phone is woken.',
      w_note_still_trying_title: 'Still trying to connect',
      w_note_still_trying_body_relayed: 'Check the monitor phone is awake with Tawny open.',
      w_note_still_trying_body_direct: 'A direct connection could not be made from this network. If both phones are on mobile data, try putting this one on Wi-Fi.',
      // --- safety code (SAS) card ---
      w_sas_code_unavailable: 'unavailable — connection may be tampered with',
      w_sas_monitor_note: 'A phone is connecting from outside your Wi-Fi. It should be showing this code',
      w_sas_monitor_fail: 'The safety code for a phone connecting from outside your Wi-Fi could not be worked out. If you did not expect that, disconnect it',
      w_sas_viewer_note: 'Check the Monitor is showing this same code. You are only asked this once for this monitor.',
      w_sas_viewer_fail: 'The safety code for this connection could not be worked out. If you did not expect that, disconnect.',
      w_sas_more: ' ({0} more phone(s) after it)',
      w_sas_looks_right: 'Looks right',
      w_sas_disconnect: 'Disconnect',
      w_sas_keep_connected: 'Keep it connected',
      w_sas_disconnect_it: 'Disconnect it',
      w_sas_note_default: 'Check this code matches the one on the other phone:',
      // --- bail() messages that surface in the native error dialog ---
      w_bail_cam_mic_generic: 'Tawny could not get to the camera and microphone on this phone. Close Tawny and open it again.',
      w_bail_cam_mic_blocked: 'Camera and microphone access was blocked. Allow it for this site, then try again.',
      w_bail_not_on_wifi: 'This phone is not on Wi-Fi yet. Connect it to Wi-Fi and try again.',
      w_bail_wifi_only_code: 'This code only works on the same Wi-Fi as the other phone. Put both phones on the same Wi-Fi and try again.',
      w_bail_already_running: 'This monitor is already running on another phone.',
      w_msg_expired: 'That pairing code has expired. Show a new code on the monitor phone and scan it again.',
    },

    es: {
      w_ctl_chime: 'Timbre',
      w_ctl_light: 'Luz',
      w_ctl_my_camera: 'Mi cámara',
      w_ctl_snapshot: 'Foto',
      w_ctl_record: 'Grabar',
      w_ctl_hang_up: 'Colgar',
      w_ctl_flip_camera: 'Girar',
      w_ctl_mute_mic: 'Silenciar',
      w_ctl_dim_screen: 'Atenuar',
      w_ctl_end_call: 'Terminar',
      w_chime_bark: 'Juguete de perro',
      w_chime_pspsps: 'Psp psp psp',
      w_chime_meow: 'Miau',
      w_chime_goodboy: 'Buen chico',
      w_chime_bell: 'Campana',
      w_aria_connecting: 'Conectando',
      w_aria_sound_level: 'Nivel de sonido del otro lado',
      w_aria_phones_watching: 'Teléfonos viendo',
      w_listening_to_you: 'Te está escuchando',
      w_hold_to_talk: 'Mantén para hablar',
      w_status_connecting: 'Conectando',
      w_status_live: 'En vivo',
      w_status_on_air: 'Al aire',
      w_status_waiting: 'Esperando',
      w_status_monitor_paused: 'Monitor en pausa',
      w_status_monitor_offline: 'Monitor sin conexión',
      w_status_reconnecting: 'Reconectando',
      w_status_paused_screen_off: 'En pausa: pantalla apagada',
      w_status_paused_tap_resume: 'En pausa: toca para reanudar',
      w_status_still_trying: 'Sigo intentando',
      w_status_call_ended: 'Llamada terminada',
      w_toast_reconnecting: 'Reconectando…',
      w_toast_taken_over: 'Otro dispositivo tomó el control de este monitor.',
      w_toast_another_phone: 'Ahora otro teléfono está usando este monitor.',
      w_toast_wifi_only: 'Ahora mismo este monitor solo se puede ver desde tu Wi-Fi. Los teléfonos en otro lugar no podrán conectarse.',
      w_toast_own_server_failed: 'Tu propio servidor no respondió. Se usará el relé de Tawny.',
      w_toast_light_off_battery: 'Se apagó la luz para ahorrar batería.',
      w_toast_could_not_switch_lens: 'No se pudo cambiar de lente.',
      w_toast_could_not_switch_camera: 'No se pudo cambiar de cámara.',
      w_toast_no_monitor_connected: 'Todavía no hay un monitor conectado.',
      w_toast_start_call_first: 'Primero inicia una llamada.',
      w_toast_could_not_open_camera: 'No se pudo abrir tu cámara.',
      w_toast_nothing_to_capture: 'Todavía no hay nada que capturar.',
      w_toast_snapshot_saved: 'Foto guardada',
      w_toast_video_not_supported: 'La grabación de video no funciona aquí.',
      w_toast_video_saved: 'Video guardado',
      w_toast_link_copied: 'Enlace copiado',
      w_note_monitor_paused_title: 'El monitor está en pausa',
      w_note_monitor_paused_body: 'Se apagó su pantalla o la app pasó a segundo plano. La imagen vuelve sola cuando se despierta el teléfono monitor.',
      w_note_still_trying_title: 'Sigo intentando conectar',
      w_note_still_trying_body_relayed: 'Comprueba que el teléfono monitor esté despierto con Tawny abierto.',
      w_note_still_trying_body_direct: 'No se pudo hacer una conexión directa desde esta red. Si los dos teléfonos están con datos móviles, prueba poner este en Wi-Fi.',
      w_sas_code_unavailable: 'no disponible: la conexión podría estar manipulada',
      w_sas_monitor_note: 'Un teléfono se está conectando desde fuera de tu Wi-Fi. Debería estar mostrando este código',
      w_sas_monitor_fail: 'No se pudo calcular el código de seguridad de un teléfono que se conecta desde fuera de tu Wi-Fi. Si no lo esperabas, desconéctalo',
      w_sas_viewer_note: 'Comprueba que el monitor esté mostrando este mismo código. Solo se te pregunta una vez por este monitor.',
      w_sas_viewer_fail: 'No se pudo calcular el código de seguridad de esta conexión. Si no lo esperabas, desconéctate.',
      w_sas_more: ' ({0} teléfono(s) más después)',
      w_sas_looks_right: 'Se ve bien',
      w_sas_disconnect: 'Desconectar',
      w_sas_keep_connected: 'Mantener conectado',
      w_sas_disconnect_it: 'Desconectarlo',
      w_sas_note_default: 'Revisa que este código coincida con el del otro teléfono:',
      w_bail_cam_mic_generic: 'Tawny no pudo acceder a la cámara y el micrófono de este teléfono. Cierra Tawny y ábrelo de nuevo.',
      w_bail_cam_mic_blocked: 'Se bloqueó el acceso a la cámara y el micrófono. Permítelo para este sitio e inténtalo de nuevo.',
      w_bail_not_on_wifi: 'Este teléfono aún no está en Wi-Fi. Conéctalo a Wi-Fi e inténtalo de nuevo.',
      w_bail_wifi_only_code: 'Este código solo funciona en la misma red Wi-Fi que el otro teléfono. Pon los dos teléfonos en la misma Wi-Fi e inténtalo de nuevo.',
      w_bail_already_running: 'Este monitor ya se está ejecutando en otro teléfono.',
      w_msg_expired: 'Ese código de vinculación caducó. Muestra un código nuevo en el teléfono monitor y escanéalo otra vez.',
    },
  };

  const T = {
    lang: 'en',
    has(l) { return Object.prototype.hasOwnProperty.call(DICT, l); },
    set(l) {
      if (l && T.has(l)) T.lang = l;
      T.applyStatic();
    },
    t(key) {
      let s = (DICT[T.lang] && DICT[T.lang][key]);
      if (s == null) s = DICT.en[key];
      if (s == null) return key;
      for (let i = 1; i < arguments.length; i++) {
        s = s.replace('{' + (i - 1) + '}', String(arguments[i]));
      }
      return s;
    },
    applyStatic(root) {
      const scope = root || document;
      scope.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = T.t(el.getAttribute('data-i18n'));
      });
      scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        el.setAttribute('aria-label', T.t(el.getAttribute('data-i18n-aria')));
      });
    },
  };

  window.TawnyT = T;
  window.t = function () { return T.t.apply(T, arguments); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { T.applyStatic(); });
  } else {
    T.applyStatic();
  }
})();
