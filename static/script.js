const doxScriptUrl = document.currentScript?.src || location.href;
const bootData = window.__DOX_BOOT__ || {};

window.doxU = window.doxU && (typeof window.doxU === 'object' || typeof window.doxU === 'function')
  ? window.doxU
  : {};
window.doxU.sessionId = bootData.sessionId;
window.doxU.track = async function track(name, properties = {}) {
  if (typeof name !== 'string') {
    throw new TypeError('Event name must be a string');
  }
  const eventName = name.trim();
  if (!eventName || [...eventName].length > 128) {
    throw new TypeError('Event name must be a non-empty string of at most 128 characters');
  }
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new TypeError('Event properties must be an object');
  }
  if (!bootData.sessionId) throw new Error('Missing collection session');

  const endpoint = new URL('./api/events', doxScriptUrl);
  const body = JSON.stringify({sessionId: bootData.sessionId, name: eventName, properties});
  if (new TextEncoder().encode(body).length > 64 * 1024) {
    throw new RangeError('Event request exceeds the 64 KiB limit');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body,
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Event request failed (${response.status})`);
  return response.json();
};

async function collect() {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const c = navigator.connection;

  async function detectEvmWallets(timeout = 300) {
    const wallets = new Map();

    function handleAnnouncement(event) {
      const info = event.detail?.info;
      if (!info) return;

      wallets.set(info.uuid || info.rdns || info.name, {
        name: info.name,
        rdns: info.rdns,
        uuid: info.uuid,
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

  async function getWebRTCIPs(timeout = 3000) {
    if (!window.RTCPeerConnection) return {
      supported: false,
      ips: [],
    };

    return new Promise(resolve => {
      const ips = new Set();
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });
    } catch {
      resolve({supported: false, ips: []});
      return;
    }
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

        const ip = parts[4];

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

  const d = {
    time: new Date().toISOString(),
    page: {
      url: location.href,
      title: document.title,
      referrer: document.referrer,
    },
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

  if (navigator.userAgentData) {
    try {
      d.uaData = {
        ...await navigator.userAgentData.getHighEntropyValues([
          'architecture',
          'bitness',
          'model',
          'platformVersion',
          'fullVersionList',
          'wow64',
        ]),
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
      };
    } catch {
      d.uaData = null;
    }
  }

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

const rawToggle = document.getElementById('raw-tab');
const overviewTab = document.getElementById('home-tab');
const entityContent = document.getElementById('entity-content');
const rawServer = document.getElementById('raw-server');
const rawClient = document.getElementById('raw-client');
const rawIp = document.getElementById('raw-ip');
const serverData = bootData.server || (rawServer ? JSON.parse(rawServer.textContent) : {});
if (rawServer && bootData.server) rawServer.textContent = JSON.stringify(bootData.server, null, 2);
if (rawIp && bootData.ipResponse) rawIp.textContent = JSON.stringify(bootData.ipResponse, null, 2);

function isPublicIp(value) {
  if (typeof value !== 'string') return false;
  const ip = value.toLowerCase().split('%')[0];
  if (ip.includes(':')) {
    const mappedV4 = ip.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedV4) return isPublicIp(mappedV4[1]);
    const firstGroup = Number.parseInt(ip.split(':').filter(Boolean)[0] || '0', 16);
    return firstGroup >= 0x2000 && firstGroup <= 0x3fff && !ip.startsWith('2001:db8:');
  }

  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && b === 168)
    && !(a === 192 && b === 0 && c === 0)
    && !(a === 192 && b === 0 && c === 2)
    && !(a === 198 && (b === 18 || b === 19))
    && !(a === 198 && b === 51 && c === 100)
    && !(a === 203 && b === 0 && c === 113);
}

async function lookupIp(ip) {
  if (!isPublicIp(ip)) return null;
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,region,city,timezone`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function lookupIpLocations(d) {
  const webrtcIps = [...new Set((d.extra?.webrtc?.ips || []).filter(ip => typeof ip === 'string'))].slice(0, 8);
  const ipValues = [...new Set([serverData.ip, serverData.peerIp, ...webrtcIps].filter(ip => typeof ip === 'string'))];
  const responses = new Map(await Promise.all(ipValues.map(async ip => [ip, await lookupIp(ip)])));
  const entry = ip => ip ? {
    ip,
    public: isPublicIp(ip),
    matchesServer: ip === serverData.ip,
    matchesPeer: ip === serverData.peerIp,
    response: responses.get(ip) || null,
  } : null;

  return {
    server: entry(serverData.ip),
    peer: entry(serverData.peerIp),
    webrtc: webrtcIps.map(entry),
  };
}

if (overviewTab && rawToggle) overviewTab.addEventListener('click', () => {
  rawToggle.checked = false;
});

function displayValue(value) {
  if (value === undefined || value === null || value === '') return 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join(', ') : 'None';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${displayValue(item)}`).join(' · ');
  return String(value);
}

function isKnown(value) {
  return value !== undefined && value !== null && value !== '' && value !== 'Unknown'
    && !(Array.isArray(value) && value.length === 0);
}

function comparableValue(value) {
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values
    .map(item => String(item).trim().toLowerCase().replace(/^google chrome\b/, 'chrome'))
    .filter(Boolean)
    .sort()
    .join('|');
}

function factRow(label, server, browser) {
  const hasServer = isKnown(server);
  const hasBrowser = isKnown(browser);
  if (hasServer && hasBrowser) {
    if (comparableValue(server) === comparableValue(browser)) return {label, value: server};
    return {label, server, client: browser, status: {text: 'Different', kind: 'diff'}};
  }
  if (hasServer) return {label, value: server};
  if (hasBrowser) return {label, value: browser};
  return null;
}

function addBadge(parent, text, kind = 'unknown') {
  const badge = document.createElement('span');
  badge.className = `badge ${kind}`;
  badge.textContent = text;
  parent.append(badge);
}

function addRow(list, rowData) {
  const {label, value, server, client, status} = rowData;
  const row = document.createElement('div');
  row.className = 'entity-row';

  const name = document.createElement('div');
  name.className = 'entity-label';
  name.textContent = label;
  row.append(name);

  const content = document.createElement('div');
  content.className = 'entity-content-cell';

  if (Object.hasOwn(rowData, 'server') || Object.hasOwn(rowData, 'client')) {
    const pair = document.createElement('div');
    pair.className = 'pair-values';
    for (const [source, item] of [['Server', server], ['Browser', client]]) {
      const cell = document.createElement('div');
      cell.className = 'pair-cell';
      const sourceLabel = document.createElement('span');
      sourceLabel.className = 'pair-source';
      sourceLabel.textContent = source;
      const valueNode = document.createElement('span');
      valueNode.className = `pair-value${item === undefined || item === null || item === '' || item === 'Unknown' ? ' muted' : ''}`;
      valueNode.textContent = displayValue(item);
      cell.append(sourceLabel, valueNode);
      pair.append(cell);
    }
    content.append(pair);
  } else if (value !== undefined) {
    const valueNode = document.createElement('span');
    valueNode.className = `entity-value${value === null || value === '' ? ' muted' : ''}`;
    valueNode.textContent = displayValue(value);
    content.append(valueNode);
  }

  if (status) addBadge(content, status.text, status.kind);
  row.append(content);
  list.append(row);
}

function addCard(container, title, rows, {icon = '•'} = {}) {
  const card = document.createElement('article');
  card.className = 'entity-card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const heading = document.createElement('div');
  const titleNode = document.createElement('h3');
  titleNode.className = 'card-title';
  titleNode.textContent = title;
  heading.append(titleNode);
  const iconNode = document.createElement('span');
  iconNode.className = 'card-icon';
  if (icon.startsWith('/icons/')) {
    const assetName = icon.slice('/icons/'.length);
    const svg = bootData.icons?.[assetName];
    if (svg) {
      iconNode.innerHTML = svg;
      iconNode.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    } else {
      iconNode.textContent = '•';
    }
  } else {
    iconNode.textContent = icon;
  }
  head.append(heading, iconNode);
  card.append(head);

  const list = document.createElement('div');
  list.className = 'entity-list';
  rows.forEach(row => addRow(list, row));
  card.append(list);
  container.append(card);
  return card;
}

function formatOffset(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Not available';
  const sign = seconds >= 0 ? '+' : '-';
  const minutes = Math.floor(Math.abs(seconds) / 60);
  return `UTC${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function getClientBrowser(d) {
  const hints = d.uaData || {};
  const brands = hints.fullVersionList?.length ? hints.fullVersionList : hints.brands;
  if (brands?.length) {
    const browser = brands.find(item => !item.brand.startsWith('Not') && item.brand !== 'Chromium');
    if (browser) return `${browser.brand} ${browser.version}`;
  }
  const patterns = [
    [/Edg\/([\d.]+)/, 'Edge'], [/OPR\/([\d.]+)/, 'Opera'],
    [/Firefox\/([\d.]+)/, 'Firefox'], [/FxiOS\/([\d.]+)/, 'Firefox iOS'],
    [/CriOS\/([\d.]+)/, 'Chrome iOS'], [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [pattern, name] of patterns) {
    const match = d.ua.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return 'Unknown';
}

function getClientDeviceType(d) {
  if (typeof d.uaData?.mobile === 'boolean') return d.uaData.mobile ? 'Mobile' : 'Desktop';
  return /Mobi|iPhone|iPad|Android/i.test(d.ua) ? 'Mobile' : 'Desktop';
}

function getClientPlatform(d) {
  if (d.uaData?.platform) return d.uaData.platform;
  if (/iPhone|iPad|iPod/i.test(d.ua || '')) return 'iOS';
  if (/Android/i.test(d.ua || '')) return 'Android';
  if (/Windows/i.test(d.ua || '')) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(d.ua || '')) return 'macOS';
  if (/CrOS/i.test(d.ua || '')) return 'ChromeOS';
  if (/Linux/i.test(d.ua || '')) return 'Linux';
  return d.platform;
}

function timezoneComparison(d, serverGeo) {
  const serverTimezone = serverGeo?.timezone?.id;
  const serverOffset = serverGeo?.timezone?.offset;
  if (!serverTimezone || !d.tz || typeof d.tzOffsetMin !== 'number' || typeof serverOffset !== 'number') {
    return {text: 'Not enough data', kind: 'unknown'};
  }
  const clientOffsetSeconds = -d.tzOffsetMin * 60;
  const sameZone = serverTimezone === d.tz;
  const sameOffset = Math.abs(serverOffset - clientOffsetSeconds) < 60;
  return sameZone && sameOffset
    ? {text: 'Matches', kind: 'match'}
    : {text: 'Different', kind: 'diff'};
}

function ipComparison(ips, lookups) {
  if (!serverData.ip || serverData.ip === 'Unknown' || !ips.length) {
    return {text: 'Not enough data', kind: 'unknown'};
  }
  const publicLookups = lookups.filter(result => result.public);
  if (!publicLookups.length) return {text: 'No public WebRTC IP', kind: 'unknown'};
  return publicLookups.some(result => !result.matchesServer)
    ? {text: 'Different IP detected', kind: 'diff'}
    : {text: 'Matches server IP', kind: 'match'};
}

function renderOverview(d, ipLookups = {server: null, peer: null, webrtc: []}, ipLookupError = null) {
  entityContent.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'entity-grid';
  entityContent.append(grid);

  const clientProfile = {
    platform: getClientPlatform(d),
    platformVersion: d.uaData?.platformVersion,
    deviceModel: d.uaData?.model,
    architecture: d.uaData?.architecture,
    bitness: d.uaData?.bitness,
  };
  const platformName = clientProfile.platform || serverData.platform;
  const platformKey = String(platformName || '').toLowerCase();
  const platformIcon = /android/.test(platformKey)
    ? '/icons/android.svg'
    : /windows/.test(platformKey)
      ? '/icons/windows.svg'
      : /ios|iphone|ipad|mac/.test(platformKey)
        ? '/icons/apple.svg'
        : '/icons/device.svg';
  const deviceRows = [
    factRow('Platform', serverData.platform, clientProfile.platform),
    factRow('OS version', serverData.platformVersion, clientProfile.platformVersion),
    factRow('Device type', serverData.deviceType, getClientDeviceType(d)),
    factRow('Model', serverData.deviceModel, clientProfile.deviceModel),
    factRow('Architecture', serverData.architecture, clientProfile.architecture),
    factRow('Bitness', serverData.bitness, clientProfile.bitness),
  ].filter(Boolean);
  if (deviceRows.length) addCard(grid, 'Device', deviceRows, {icon: platformIcon});

  const browserRows = [
    factRow('Browser', serverData.browser, getClientBrowser(d)),
  ].filter(Boolean);
  if (browserRows.length) addCard(grid, 'Browser', browserRows, {icon: '/icons/browser.svg'});

  const screen = d.screen || {};
  const viewport = d.viewport || {};
  const devices = d.extra?.devices || {};
  const hardwareRows = [];
  if (screen.w && screen.h) hardwareRows.push({label: 'Screen', value: `${screen.w} × ${screen.h} px`});
  if (viewport.w && viewport.h && (viewport.w !== screen.w || viewport.h !== screen.h)) {
    hardwareRows.push({label: 'Viewport', value: `${viewport.w} × ${viewport.h} px`});
  }
  if (screen.dpr) hardwareRows.push({label: 'Pixel ratio', value: `${screen.dpr}×`});
  if (screen.colorDepth) hardwareRows.push({label: 'Color depth', value: `${screen.colorDepth} bit`});
  if (typeof d.cores === 'number') hardwareRows.push({label: 'CPU cores', value: d.cores});
  if (typeof d.memoryGB === 'number') hardwareRows.push({label: 'Memory estimate', value: `${d.memoryGB} GB`});
  if (typeof d.touchPoints === 'number') hardwareRows.push({label: 'Touch points', value: d.touchPoints});
  if (typeof devices.total === 'number') hardwareRows.push({label: 'Media devices', value: devices.total});
  if (hardwareRows.length) addCard(grid, 'Hardware & display', hardwareRows, {icon: '/icons/hardware.svg'});

  const uniqueWebrtcIps = [...new Set((d.extra?.webrtc?.ips || []).filter(ip => typeof ip === 'string'))];
  const differentWebrtcIps = (ipLookups.webrtc || [])
    .filter(result => result.public && !result.matchesServer)
    .map(result => result.ip);
  const peerStatus = serverData.ipSource === 'connection'
    ? {text: 'No forwarded IP; using peer', kind: 'unknown'}
    : serverData.ipMatchesPeer
      ? {text: 'Same IP', kind: 'match'}
      : {text: 'Different IP', kind: 'diff'};
  const networkRows = [
    {label: serverData.ip === serverData.peerIp ? 'IP address' : 'IP seen by app', value: serverData.ip},
    ...(serverData.ip === serverData.peerIp ? [] : [{label: 'Connection peer', value: serverData.peerIp}]),
    {label: 'Forwarded IP check', status: peerStatus},
    {label: 'WebRTC check', status: ipComparison(uniqueWebrtcIps, ipLookups.webrtc || [])},
  ];
  if (differentWebrtcIps.length) networkRows.push({label: 'Other WebRTC IPs', value: differentWebrtcIps});
  const network = d.network || {};
  if (typeof d.online === 'boolean') networkRows.push({label: 'Internet', value: d.online ? 'Online' : 'Offline'});
  if (network.type) networkRows.push({label: 'Connection type', value: network.type});
  if (typeof network.rtt === 'number') networkRows.push({label: 'Round-trip time', value: `${network.rtt} ms`});
  if (typeof network.downlink === 'number') networkRows.push({label: 'Downlink estimate', value: `${network.downlink} Mbps`});
  addCard(grid, 'Network & IP', networkRows, {icon: '/icons/network.svg'});

  const serverGeo = ipLookups.server?.response;
  const peerGeo = ipLookups.peer?.response;
  const placeFor = response => response?.success === true
    ? [response.city, response.region, response.country].filter(Boolean).join(', ')
    : '';
  const placeLabels = new Map();
  const addPlace = (label, ip, response) => {
    if (!ip || !response?.success) return;
    const place = placeFor(response);
    if (!place) return;
    const labels = placeLabels.get(place) || [];
    labels.push(label);
    placeLabels.set(place, labels);
  };
  addPlace(serverData.ip === serverData.peerIp ? 'IP' : 'App IP', serverData.ip, serverGeo);
  if (serverData.peerIp !== serverData.ip) addPlace('Peer', serverData.peerIp, peerGeo);
  for (const result of ipLookups.webrtc || []) {
    if (result.ip !== serverData.ip && result.ip !== serverData.peerIp) addPlace('WebRTC', result.ip, result.response);
  }
  const locationRows = [...placeLabels].map(([place, labels]) => ({
    label: [...new Set(labels)].join(' + '),
    value: place,
  }));
  if (!locationRows.length) locationRows.push({label: 'IP location', value: 'Not available'});
  addCard(grid, 'Location', locationRows, {icon: '/icons/location.svg'});

  const serverTimezone = serverGeo?.timezone?.id;
  const serverOffset = serverGeo?.timezone?.offset;
  const zoneCheck = timezoneComparison(d, serverGeo);
  let timezoneRows;
  if (serverTimezone && d.tz && serverTimezone === d.tz) {
    const sameZoneStatus = zoneCheck.kind === 'diff'
      ? zoneCheck
      : {text: 'Same timezone', kind: 'match'};
    timezoneRows = [{label: 'Timezone', value: serverTimezone, status: sameZoneStatus}];
    if (zoneCheck.kind === 'diff') {
      timezoneRows.push({label: 'IP UTC offset', value: formatOffset(serverOffset)});
      timezoneRows.push({label: 'Browser UTC offset', value: formatOffset(-d.tzOffsetMin * 60)});
    }
  } else if (serverTimezone && d.tz) {
    timezoneRows = [
      {label: 'IP timezone', value: serverTimezone},
      {label: 'Browser timezone', value: d.tz},
      {label: 'Comparison', status: zoneCheck},
    ];
    if (typeof serverOffset === 'number') timezoneRows.push({label: 'IP UTC offset', value: formatOffset(serverOffset)});
    if (typeof d.tzOffsetMin === 'number') timezoneRows.push({label: 'Browser UTC offset', value: formatOffset(-d.tzOffsetMin * 60)});
  } else {
    timezoneRows = [factRow('Timezone', serverTimezone, d.tz)].filter(Boolean);
  }
  if (timezoneRows.length) addCard(grid, 'Timezone', timezoneRows, {icon: '/icons/timezone.svg'});

  const clientLanguages = Array.isArray(d.languages) ? d.languages : String(d.languages || '').split(',');
  const localeIsLanguage = d.locale && clientLanguages.some(language => String(language).toLowerCase() === d.locale.toLowerCase());
  const languageRows = [
    factRow('Languages', serverData.languages, d.languages),
    d.locale && !localeIsLanguage ? {label: 'Locale', value: d.locale} : null,
  ].filter(Boolean);
  if (languageRows.length) addCard(grid, 'Language', languageRows, {icon: '/icons/language.svg'});

  if (ipLookupError) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = 'Some IP-based location details could not be loaded.';
    entityContent.append(notice);
  }
}

async function submitVisit(clientData, ipResponses) {
  const endpoint = new URL('./api/collect', doxScriptUrl);
  const payload = {sessionId: bootData.sessionId, ipResponses};
  if (clientData !== null) payload.clientData = clientData;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Collection request failed (${response.status})`);
  return response.json();
}

collect().then(async d => {
  if (!bootData.sessionId) throw new Error('Missing collection session');
  if (rawClient) rawClient.textContent = JSON.stringify(d, null, 2);
  if (entityContent) renderOverview(d);
  try {
    const initial = await submitVisit(d, bootData.ipResponse || {});
    if (rawServer) rawServer.textContent = JSON.stringify(initial.server, null, 2);
    if (rawClient) rawClient.textContent = JSON.stringify(initial.client, null, 2);
    if (rawIp) rawIp.textContent = JSON.stringify(initial.ip, null, 2);

    try {
      const ipResponses = await lookupIpLocations(d);
      const result = await submitVisit(null, ipResponses);
      if (rawServer) rawServer.textContent = JSON.stringify(result.server, null, 2);
      if (rawClient) rawClient.textContent = JSON.stringify(result.client, null, 2);
      if (rawIp) rawIp.textContent = JSON.stringify(result.ip, null, 2);
      if (entityContent) renderOverview(d, result.ip);
    } catch (error) {
      if (rawIp) rawIp.textContent = JSON.stringify({error: String(error), ...(initial.ip || {})}, null, 2);
      if (entityContent) renderOverview(d, initial.ip, error);
      console.error(error);
    }
  } catch (error) {
    if (rawIp) rawIp.textContent = JSON.stringify({error: String(error), ...(bootData.ipResponse || {})}, null, 2);
    if (entityContent) renderOverview(d, bootData.ipResponse || {server: null, peer: null, webrtc: []}, error);
    console.error(error);
  }
}).catch(error => {
  if (rawClient) rawClient.textContent = JSON.stringify({error: String(error)}, null, 2);
  if (entityContent) {
    entityContent.replaceChildren();
    const message = document.createElement('div');
    message.className = 'loading';
    message.textContent = 'Browser data could not be collected.';
    entityContent.append(message);
  }
  console.error(error);
});
