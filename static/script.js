
async function collect() {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const c = navigator.connection;

  // EVM wallets: EIP-6963 + legacy provider
  async function detectEvmWallets(timeout = 300) {
    const wallets = new Map();

    function handleAnnouncement(event) {
      const info = event.detail?.info;
      if (!info) return;

      wallets.set(info.uuid || info.rdns || info.name, {
        name: info.name,
        rdns: info.rdns,
        uuid: info.uuid,
        // icon: info.icon,
      });
    }

    window.addEventListener('eip6963:announceProvider', handleAnnouncement);

    try {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise(resolve => setTimeout(resolve, timeout));
    } finally {
      window.removeEventListener('eip6963:announceProvider', handleAnnouncement);
    }

    if (window.ethereum && wallets.size === 0) {
      wallets.set('legacy', {
        name: 'Unknown EVM wallet',
        legacy: true,
      });
    }

    return [...wallets.values()];
  }

  // Solana wallets
  function detectSolanaWallets() {
    const wallets = [];

    if (window.solana) {
      wallets.push({
        name: window.solana.isPhantom ? 'Phantom' : 'Unknown Solana wallet',
        isPhantom: !!window.solana.isPhantom,
      });
    }

    if (window.phantom?.solana) wallets.push({name: 'Phantom'});
    if (window.backpack) wallets.push({name: 'Backpack'});
    if (window.solflare) wallets.push({name: 'Solflare'});

    return wallets;
  }

  // WebRTC ICE candidates
  // Collects only addresses exposed by the browser.
  // Does not guarantee discovery of the public IP.
  async function getWebRTCIPs(timeout = 3000) {
    if (!window.RTCPeerConnection) return {
      supported: false,
      ips: [],
    };

    return new Promise(resolve => {
      const ips = new Set();
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      })
      let finished = false;

      function finish() {
        if (finished) return;
        finished = true;

        pc.onicecandidate = null;
        pc.onicegatheringstatechange = null;
        pc.close();

        resolve({
          supported: true,
          ips: [...ips],
        });
      }

      pc.onicecandidate = event => {
        if (!event.candidate) {
          finish();
          return;
        }



        const candidate = event.candidate.candidate;
        
        const parts = candidate.split(/\s+/);

        console.log(parts)
        // ICE candidate address is field 5 (zero-based index 4).
        const ip = parts[4];
        console.log(ip)

        if (
          ip &&
          ip !== '0.0.0.0' &&
          ip !== '::' &&
          !ip.endsWith('.local')
        ) {
          ips.add(ip);
        }
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };

      pc.createDataChannel('probe');

      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(finish);

      setTimeout(finish, timeout);
    });
  }

  // GPU / WebGL
  function getGPU() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');

    if (!gl) return null;

    const ext = gl.getExtension('WEBGL_debug_renderer_info');

    return {
      vendor: ext
        ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),

      renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),

      version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    };
  }

  // Storage
  async function getStorage() {
    if (!navigator.storage?.estimate) return null;

    try {
      const {usage, quota} = await navigator.storage.estimate();

      return {
        usage,
        quota,
        available: quota != null && usage != null ? quota - usage : null,
      };
    } catch {
      return null;
    }
  }

  // Media codecs
  async function getMediaCapabilities() {
    const formats = [
      'video/mp4; codecs="avc1.42E01E"',
      'video/webm; codecs="vp9"',
      'video/webm; codecs="vp8"',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/ogg; codecs="opus"',
    ];

    const result = {};

    for (const format of formats) {
      result[format] = typeof MediaSource !== 'undefined'
        ? MediaSource.isTypeSupported(format)
        : null;
    }

    return result;
  }

  // Permission states (without requesting permissions)
  async function getPermissionStates() {
    if (!navigator.permissions) return {};

    const names = [
      'geolocation',
      'notifications',
      'camera',
      'microphone',
      'clipboard-read',
      'clipboard-write',
      'persistent-storage',
    ];

    const result = {};

    await Promise.all(names.map(async name => {
      try {
        const permission = await navigator.permissions.query({name});
        result[name] = permission.state;
      } catch {
        result[name] = 'unsupported';
      }
    }));

    return result;
  }

  // Media devices (without requesting access)
  async function getDeviceInfo() {
    if (!navigator.mediaDevices?.enumerateDevices) return null;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      return {
        total: devices.length,
        audioInputs: devices.filter(x => x.kind === 'audioinput').length,
        audioOutputs: devices.filter(x => x.kind === 'audiooutput').length,
        videoInputs: devices.filter(x => x.kind === 'videoinput').length,
      };
    } catch {
      return null;
    }
  }

  // Original data
  const d = {
    time: new Date().toISOString(),
    tz: intl.timeZone,
    tzOffsetMin: new Date().getTimezoneOffset(),
    locale: intl.locale,
    languages: navigator.languages,
    ua: navigator.userAgent,
    platform: navigator.platform,

    screen: {
      w: screen.width,
      h: screen.height,
      availW: screen.availWidth,
      availH: screen.availHeight,
      colorDepth: screen.colorDepth,
      dpr: devicePixelRatio,
    },

    viewport: {
      w: innerWidth,
      h: innerHeight,
    },

    cores: navigator.hardwareConcurrency,
    memoryGB: navigator.deviceMemory,
    touchPoints: navigator.maxTouchPoints,
    cookiesEnabled: navigator.cookieEnabled,
    dnt: navigator.doNotTrack,
    gpc: navigator.globalPrivacyControl,
    online: navigator.onLine,

    darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,

    network: c && {
      type: c.effectiveType,
      downlink: c.downlink,
      rtt: c.rtt,
      saveData: c.saveData,
    },
  };

  // Original User-Agent Client Hints
  if (navigator.userAgentData) {
    try {
      d.uaData = await navigator.userAgentData.getHighEntropyValues([
        'architecture',
        'bitness',
        'model',
        'platformVersion',
        'fullVersionList',
        'wow64',
      ]);
    } catch {
      d.uaData = null;
    }
  }

  // Additional capabilities
  const [
    evmWallets,
    storage,
    media,
    permissions,
    devices,
    webrtc,
  ] = await Promise.all([
    detectEvmWallets(),
    getStorage(),
    getMediaCapabilities(),
    getPermissionStates(),
    getDeviceInfo(),
    getWebRTCIPs(),
  ]);

  const canvas = document.createElement('canvas');

  d.extra = {
    wallets: {
      evm: evmWallets,
      solana: detectSolanaWallets(),
    },

    webrtc,

    gpu: getGPU(),

    storage,
    media,
    permissions,
    devices,

    capabilities: {
      webgl: !!canvas.getContext('webgl'),
      webgl2: !!canvas.getContext('webgl2'),
      webgpu: !!navigator.gpu,

      bluetooth: !!navigator.bluetooth,
      usb: !!navigator.usb,
      serial: !!navigator.serial,
      hid: !!navigator.hid,
      midi: !!navigator.requestMIDIAccess,

      serviceWorker: 'serviceWorker' in navigator,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',

      mediaDevices: !!navigator.mediaDevices,
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      indexedDB: !!window.indexedDB,

      localStorage: (() => {
        try {
          const key = '__storage_test__';
          localStorage.setItem(key, '1');
          localStorage.removeItem(key);
          return true;
        } catch {
          return false;
        }
      })(),

      pointer: {
        fine: matchMedia('(pointer: fine)').matches,
        coarse: matchMedia('(pointer: coarse)').matches,
        anyFine: matchMedia('(any-pointer: fine)').matches,
        anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      },

      hover: {
        hover: matchMedia('(hover: hover)').matches,
        anyHover: matchMedia('(any-hover: hover)').matches,
      },

      display: {
        hdr: matchMedia('(dynamic-range: high)').matches,
        p3: matchMedia('(color-gamut: p3)').matches,
        srgb: matchMedia('(color-gamut: srgb)').matches,
      },
    },
  };

  return d;
}

collect().then(d => {
  document.getElementById('client').textContent =
    JSON.stringify(d, null, 2);
}).catch(console.error);
