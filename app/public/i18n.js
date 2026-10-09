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
      // --- theme toggle ---
      w_theme_change: 'Change theme',
      w_theme_system: 'Theme: follow system',
      w_theme_light: 'Theme: light',
      w_theme_dark: 'Theme: dark',
      // --- first-call walkthrough ---
      w_coach_talk: 'Hold this to talk to your pet. Let go and the room stops hearing you.',
      w_coach_chime: 'Play a sound on the Monitor — a squeaky toy, a meow, a bell — to call them over.',
      w_coach_light: 'Turn on the Monitor’s light to see into a dark room.',
      w_coach_snap: 'Save a photo of what the Monitor sees right now.',
      w_coach_leave: 'Hang up here. The Monitor keeps watching, so you can look in again any time.',
      w_coach_dim: 'Once a phone is watching, dim the screen. The stream keeps running and the battery lasts far longer.',
      w_coach_flip: 'Switch between the front and back camera.',
      w_coach_stop: 'Stop monitoring. Viewers can’t look in until you start again.',
      w_coach_next: 'Next',
      w_coach_done: 'Got it',
      w_coach_skip: 'Skip',
      // --- live controls (static markup) ---
      w_ctl_chime: 'Chime',
      w_ctl_light: 'Light',
      w_ctl_my_camera: 'My camera',
      w_ctl_snapshot: 'Snapshot',
      w_ctl_record: 'Record',
      w_ctl_hang_up: 'Hang up',
      w_ctl_flip_camera: 'Flip camera',
      w_ctl_mute_mic: 'Mute mic',
      w_ctl_mute_listen: 'Mute',
      w_ctl_unmute: 'Unmute',
      w_ctl_dim_screen: 'Dim screen',
      w_ctl_end_call: 'End call',
      w_ctl_unmute_mic: 'Unmute mic',
      w_ctl_talking: 'Talking',
      w_ctl_light_on: 'Light on',
      w_toast_recording: 'Recording — up to {0}s',
      w_toast_front_camera: 'Front camera',
      w_toast_rear_camera: 'Rear camera',
      w_toast_chime_played: '{0} played on the Monitor',
      w_torch_hint_back_camera: 'Switch the monitor to its back camera.',
      w_torch_hint_no_light: 'The monitor’s camera has no light.',
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
      w_aria_announce: 'Viewers are announced with a sound',
      w_announce_chip: 'Announced',
      w_who_title: 'Who’s here',
      w_who_old: 'The Monitor is on an older Tawny, so it can’t share who else is watching.',
      w_who_rename: 'Change my name',
      w_who_close: 'Done',
      w_who_you: 'You',
      w_who_monitor: 'Monitor',
      w_who_viewer: 'Viewer',
      w_who_noname: 'No name given',
      w_who_open: 'See who’s here',
      w_myname_title: 'What should the others call you?',
      w_myname_label: 'Your name',
      w_myname_ph: 'Alex',
      w_myname_hint: 'Everyone on this camera sees it next to this device. Leave it empty to show just the device.',
      w_myname_skip: 'Not now',
      w_myname_save: 'Save',
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
      w_toast_strict_no_answer: 'Your own server is not answering. Tighter privacy is on, so nothing falls back. Check the address, or that it is up.',
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
      w_bail_cam_mic_failed: 'Could not open the camera or microphone ({0}).',
      w_bail_not_on_wifi: 'This phone is not on Wi-Fi yet. Connect it to Wi-Fi and try again.',
      w_bail_wifi_only_code: 'This code only works on the same Wi-Fi as the other phone. Put both phones on the same Wi-Fi and try again.',
      w_bail_already_running: 'This monitor is already running on another phone.',
      // The relay has no ticket for this room at all: the Monitor is not running,
      // which is a different thing from a code that stopped working. Saying
      // "expired" here sent people back to rescan the same QR for ever.
      w_bail_monitor_offline: 'The monitor is not online yet. Open Tawny on the monitor phone or computer and press Start, then scan again.',
      w_bail_code_only: 'The server is not set up for code-only pairing. This code has no ticket for it, so it only works directly on the Monitor’s Wi-Fi. Pair on that Wi-Fi, or turn the Monitor’s relay back on in Servers.',
      w_msg_expired: 'That pairing code has expired. Show a new code on the monitor phone and scan it again.',
      w_msg_full: 'This monitor is full ({0} phones). Close Tawny on one of the other phones, then try this code again.',
      // --- update board ---
      w_whatsnew_eyebrow: 'Updated to v{0}',
      w_whatsnew_title: 'Tawny just got better',
      w_whatsnew_changelog: 'Read the full changelog',
      w_whatsnew_thanks: 'Thank you for supporting Tawny. It stays free for everyone because of people like you.',
      w_whatsnew_done: 'Let’s go',
    },

    es: {
      // --- theme toggle ---
      w_theme_change: 'Cambiar tema',
      w_theme_system: 'Tema: según el sistema',
      w_theme_light: 'Tema: claro',
      w_theme_dark: 'Tema: oscuro',
      // --- first-call walkthrough ---
      w_coach_talk: 'Mantén pulsado para hablarle a tu mascota. Al soltar, la habitación deja de oírte.',
      w_coach_chime: 'Reproduce un sonido en el Monitor — un juguete, un maullido, una campana — para llamarla.',
      w_coach_light: 'Enciende la luz del Monitor para ver en una habitación oscura.',
      w_coach_snap: 'Guarda una foto de lo que ve el Monitor ahora mismo.',
      w_coach_leave: 'Cuelga aquí. El Monitor sigue vigilando, así que puedes volver a mirar cuando quieras.',
      w_coach_dim: 'Cuando un teléfono esté mirando, oscurece la pantalla. La transmisión sigue y la batería dura mucho más.',
      w_coach_flip: 'Cambia entre la cámara frontal y la trasera.',
      w_coach_stop: 'Deja de vigilar. Nadie podrá mirar hasta que vuelvas a empezar.',
      w_coach_next: 'Siguiente',
      w_coach_done: 'Entendido',
      w_coach_skip: 'Omitir',
      w_ctl_chime: 'Timbre',
      w_ctl_light: 'Luz',
      w_ctl_my_camera: 'Mi cámara',
      w_ctl_snapshot: 'Foto',
      w_ctl_record: 'Grabar',
      w_ctl_hang_up: 'Colgar',
      w_ctl_flip_camera: 'Girar',
      w_ctl_mute_mic: 'Silenciar',
      w_ctl_mute_listen: 'Silenciar',
      w_ctl_unmute: 'Activar sonido',
      w_ctl_dim_screen: 'Atenuar',
      w_ctl_end_call: 'Terminar',
      w_ctl_unmute_mic: 'Activar micrófono',
      w_ctl_talking: 'Hablando',
      w_ctl_light_on: 'Luz encendida',
      w_toast_recording: 'Grabando: hasta {0} s',
      w_toast_front_camera: 'Cámara frontal',
      w_toast_rear_camera: 'Cámara trasera',
      w_toast_chime_played: '{0} sonó en el monitor',
      w_torch_hint_back_camera: 'Cambia el monitor a su cámara trasera.',
      w_torch_hint_no_light: 'La cámara del monitor no tiene luz.',
      w_chime_bark: 'Juguete de perro',
      w_chime_pspsps: 'Psp psp psp',
      w_chime_meow: 'Miau',
      w_chime_goodboy: 'Buen chico',
      w_chime_bell: 'Campana',
      w_aria_connecting: 'Conectando',
      w_aria_sound_level: 'Nivel de sonido del otro lado',
      w_aria_phones_watching: 'Teléfonos viendo',
      w_aria_announce: 'Se avisa con un sonido cuando alguien mira',
      w_announce_chip: 'Con aviso',
      w_who_title: 'Quién está',
      w_who_old: 'El monitor tiene una versión antigua de Tawny y no puede decir quién más está mirando.',
      w_who_rename: 'Cambiar mi nombre',
      w_who_close: 'Listo',
      w_who_you: 'Tú',
      w_who_monitor: 'Monitor',
      w_who_viewer: 'Visor',
      w_who_noname: 'Sin nombre',
      w_who_open: 'Ver quién está',
      w_myname_title: '¿Cómo quieres que te llamen?',
      w_myname_label: 'Tu nombre',
      w_myname_ph: 'Alex',
      w_myname_hint: 'Todos los que usan esta cámara lo ven junto a este dispositivo. Déjalo vacío para mostrar solo el dispositivo.',
      w_myname_skip: 'Ahora no',
      w_myname_save: 'Guardar',
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
      w_toast_strict_no_answer: 'Tu propio servidor no responde. La privacidad estricta está activa, así que nada lo reemplaza. Revisa la dirección o que esté en línea.',
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
      w_bail_cam_mic_failed: 'No se pudo abrir la cámara o el micrófono ({0}).',
      w_bail_not_on_wifi: 'Este teléfono aún no está en Wi-Fi. Conéctalo a Wi-Fi e inténtalo de nuevo.',
      w_bail_wifi_only_code: 'Este código solo funciona en la misma red Wi-Fi que el otro teléfono. Pon los dos teléfonos en la misma Wi-Fi e inténtalo de nuevo.',
      w_bail_already_running: 'Este monitor ya se está ejecutando en otro teléfono.',
      w_bail_monitor_offline: 'El monitor aún no está en línea. Abre Tawny en el teléfono o la computadora del monitor y pulsa Iniciar, luego vuelve a escanear.',
      w_bail_code_only: 'El servidor no está configurado para emparejar solo con código. Este código no trae ticket para él, así que solo funciona directamente en el Wi-Fi del monitor. Empareja en ese Wi-Fi o vuelve a activar el relé del monitor en Servidores.',
      w_msg_expired: 'Ese código de vinculación caducó. Muestra un código nuevo en el teléfono monitor y escanéalo otra vez.',
      w_msg_full: 'Este monitor está lleno ({0} teléfonos). Cierra Tawny en uno de los otros teléfonos y vuelve a probar este código.',
      // --- panel de novedades ---
      w_whatsnew_eyebrow: 'Actualizado a v{0}',
      w_whatsnew_title: 'Tawny ahora es mejor',
      w_whatsnew_changelog: 'Ver el registro de cambios',
      w_whatsnew_thanks: 'Gracias por apoyar Tawny. Sigue siendo gratis para todos gracias a personas como tú.',
      w_whatsnew_done: '¡Vamos!',
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
