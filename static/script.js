
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

        // ICE candidate address is field 5 (zero-based index 4).
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

const rawToggle = document.getElementById('raw-tab');
const overviewTab = document.getElementById('home-tab');
const entityContent = document.getElementById('entity-content');
const rawServer = document.getElementById('raw-server');
const rawClient = document.getElementById('raw-client');
const rawIp = document.getElementById('raw-ip');
const serverData = JSON.parse(rawServer.textContent);
const initialIpData = JSON.parse(rawIp.textContent);

overviewTab.addEventListener('click', () => {
  rawToggle.checked = false;
});

function displayValue(value) {
  if (value === undefined || value === null || value === '') return 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join(', ') : 'None';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${displayValue(item)}`).join(' · ');
  return String(value);
}

function addBadge(parent, text, kind = 'unknown') {
  const badge = document.createElement('span');
  badge.className = `badge ${kind}`;
  badge.textContent = text;
  parent.append(badge);
}

function addRow(list, rowData) {
  const {label, value, server, client, status, detail} = rowData;
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
    for (const [source, item] of [['Server', server], ['Client', client]]) {
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
  if (detail) {
    const note = document.createElement('div');
    note.className = 'notice';
    note.textContent = detail;
    content.append(note);
  }
  row.append(content);
  list.append(row);
}

function addCard(container, title, rows, {wide = false, subtitle = '', icon = '•'} = {}) {
  const card = document.createElement('article');
  card.className = `entity-card${wide ? ' wide' : ''}`;
  const head = document.createElement('div');
  head.className = 'card-head';
  const heading = document.createElement('div');
  const titleNode = document.createElement('h3');
  titleNode.className = 'card-title';
  titleNode.textContent = title;
  heading.append(titleNode);
  if (subtitle) {
    const subtitleNode = document.createElement('p');
    subtitleNode.className = 'card-subtitle';
    subtitleNode.textContent = subtitle;
    heading.append(subtitleNode);
  }
  const iconNode = document.createElement('span');
  iconNode.className = 'card-icon';
  iconNode.textContent = icon;
  head.append(heading, iconNode);
  card.append(head);

  const list = document.createElement('div');
  list.className = 'entity-list';
  rows.forEach(row => addRow(list, row));
  card.append(list);
  container.append(card);
  return card;
}

function addSectionHeading(container, title, description) {
  const section = document.createElement('div');
  section.className = 'section-heading';
  const text = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = title;
  const subtitle = document.createElement('p');
  subtitle.textContent = description;
  text.append(heading, subtitle);
  section.append(text);
  container.append(section);
}

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
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

function timezoneComparison(d) {
  if (!serverData.timezone || !d.tz || typeof d.tzOffsetMin !== 'number' || typeof serverData.timezoneOffsetSeconds !== 'number') {
    return {text: 'Not enough data', kind: 'unknown'};
  }
  const clientOffsetSeconds = -d.tzOffsetMin * 60;
  const sameZone = serverData.timezone === d.tz;
  const sameOffset = Math.abs(serverData.timezoneOffsetSeconds - clientOffsetSeconds) < 60;
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

function renderOverview(d, ipLookups = [], ipLookupError = null) {
  entityContent.replaceChildren();
  addSectionHeading(entityContent, 'Identity & location', 'The same entities compared across server and browser signals.');
  const grid = document.createElement('div');
  grid.className = 'entity-grid';
  entityContent.append(grid);

  const clientProfile = {
    platform: d.uaData?.platform || d.platform,
    platformVersion: d.uaData?.platformVersion,
    deviceModel: d.uaData?.model,
    architecture: d.uaData?.architecture,
    bitness: d.uaData?.bitness,
  };
  addCard(grid, 'Device & browser', [
    {label: 'Platform', server: serverData.platform, client: clientProfile.platform},
    {label: 'Platform version', server: serverData.platformVersion, client: clientProfile.platformVersion},
    {label: 'Device type', server: serverData.deviceType, client: getClientDeviceType(d)},
    {label: 'Device model', server: serverData.deviceModel, client: clientProfile.deviceModel},
    {label: 'Architecture', server: serverData.architecture, client: clientProfile.architecture},
    {label: 'Bitness', server: serverData.bitness, client: clientProfile.bitness},
    {label: 'Browser', server: serverData.browser, client: getClientBrowser(d)},
    {label: 'Languages', server: serverData.languages, client: d.languages},
  ], {wide: true, subtitle: 'Server received / Browser reports', icon: 'D'});

  addCard(grid, 'Timezone', [
    {label: 'Timezone', server: serverData.timezone, client: d.tz},
    {label: 'UTC offset', server: serverData.timezone ? formatOffset(serverData.timezoneOffsetSeconds) : null, client: formatOffset(-d.tzOffsetMin * 60)},
    {label: 'Comparison', status: timezoneComparison(d)},
    {label: 'Locale', client: d.locale},
    {label: 'Captured at', client: d.time ? new Date(d.time).toLocaleString() : null},
  ], {subtitle: 'IP-based timezone compared with the browser timezone', icon: '◷'});

  const serverPlace = [serverData.city, serverData.region, serverData.country].filter(value => value && value !== 'Unknown').join(', ') || 'Not available';
  addCard(grid, 'Server IP & location', [
    {label: 'Server-visible IP', value: serverData.ip},
    {label: 'Geolocation', value: serverPlace},
    {label: 'Timezone', value: serverData.timezone},
  ], {subtitle: 'Location estimated for the IP seen by the server', icon: '⌖'});

  const webrtcIps = d.extra?.webrtc?.ips || [];
  const ipStatus = ipComparison(webrtcIps, ipLookups);
  addCard(grid, 'WebRTC IP addresses', [
    {label: 'Comparison', status: ipStatus},
    {label: 'Server IP', value: serverData.ip},
    {label: 'WebRTC supported', value: d.extra?.webrtc?.supported},
    {label: 'WebRTC candidates', value: webrtcIps},
  ], {subtitle: 'Public candidates are compared with the server-visible IP', icon: '⇄'});

  addSectionHeading(entityContent, 'Browser & device signals', 'Values available from browser APIs in this session.');
  const signals = document.createElement('div');
  signals.className = 'entity-grid';
  entityContent.append(signals);

  const screen = d.screen || {};
  const viewport = d.viewport || {};
  addCard(signals, 'Display', [
    {label: 'Screen', value: `${screen.w ?? '—'} × ${screen.h ?? '—'} px`},
    {label: 'Available area', value: `${screen.availW ?? '—'} × ${screen.availH ?? '—'} px`},
    {label: 'Viewport', value: `${viewport.w ?? '—'} × ${viewport.h ?? '—'} px`},
    {label: 'Color depth', value: screen.colorDepth ? `${screen.colorDepth} bit` : null},
    {label: 'Pixel ratio', value: screen.dpr},
  ], {icon: '▣'});

  addCard(signals, 'Hardware', [
    {label: 'CPU cores', value: d.cores},
    {label: 'Memory estimate', value: typeof d.memoryGB === 'number' ? `${d.memoryGB} GB` : null},
    {label: 'Touch points', value: d.touchPoints},
    {label: 'WOW64', value: d.uaData?.wow64},
    {label: 'Media devices', value: d.extra?.devices?.total},
    {label: 'Audio inputs', value: d.extra?.devices?.audioInputs},
    {label: 'Audio outputs', value: d.extra?.devices?.audioOutputs},
    {label: 'Video inputs', value: d.extra?.devices?.videoInputs},
  ], {subtitle: 'Browser-reported values; some may be rounded or restricted', icon: '⌘'});

  const network = d.network || {};
  addCard(signals, 'Network', [
    {label: 'Online', value: d.online},
    {label: 'Effective type', value: network.type},
    {label: 'Downlink estimate', value: typeof network.downlink === 'number' ? `${network.downlink} Mbps` : null},
    {label: 'Round-trip time', value: typeof network.rtt === 'number' ? `${network.rtt} ms` : null},
    {label: 'Data saver', value: network.saveData},
  ], {icon: '⌁'});

  addCard(signals, 'Privacy & preferences', [
    {label: 'Cookies enabled', value: d.cookiesEnabled},
    {label: 'Do Not Track', value: d.dnt},
    {label: 'Global Privacy Control', value: d.gpc},
    {label: 'Dark mode', value: d.darkMode},
    {label: 'Reduced motion', value: d.reducedMotion},
  ], {icon: '◈'});

  const gpu = d.extra?.gpu || {};
  addCard(signals, 'Graphics', [
    {label: 'GPU vendor', value: gpu.vendor},
    {label: 'Renderer', value: gpu.renderer},
    {label: 'WebGL version', value: gpu.version},
    {label: 'Shader language', value: gpu.shadingLanguage},
  ], {icon: '◩'});

  const storage = d.extra?.storage || {};
  addCard(signals, 'Storage', [
    {label: 'Usage', value: formatBytes(storage.usage)},
    {label: 'Quota', value: formatBytes(storage.quota)},
    {label: 'Available', value: formatBytes(storage.available)},
  ], {icon: '▤'});

  const media = d.extra?.media || {};
  const codecs = [
    ['H.264 / MP4', 'video/mp4; codecs="avc1.42E01E"'],
    ['VP9 / WebM', 'video/webm; codecs="vp9"'],
    ['VP8 / WebM', 'video/webm; codecs="vp8"'],
    ['AAC / MP4', 'audio/mp4; codecs="mp4a.40.2"'],
    ['Opus / Ogg', 'audio/ogg; codecs="opus"'],
  ];
  addCard(signals, 'Media formats', codecs.map(([label, key]) => ({label, value: media[key]})), {icon: '▷'});

  const permissions = d.extra?.permissions || {};
  const permissionRows = Object.entries(permissions).map(([name, state]) => ({label: name, value: state}));
  addCard(signals, 'Permissions', permissionRows.length ? permissionRows : [{label: 'Permission API', value: 'Not available'}], {subtitle: 'States are read without requesting access', icon: '✓'});

  const capabilities = d.extra?.capabilities || {};
  const capabilityRows = [];
  const capabilityLabels = {
    webgl: 'WebGL', webgl2: 'WebGL 2', webgpu: 'WebGPU', bluetooth: 'Bluetooth', usb: 'USB',
    serial: 'Serial', hid: 'HID', midi: 'MIDI', serviceWorker: 'Service worker',
    sharedArrayBuffer: 'SharedArrayBuffer', mediaDevices: 'Media devices',
    broadcastChannel: 'BroadcastChannel', indexedDB: 'IndexedDB', localStorage: 'Local storage',
  };
  for (const [key, label] of Object.entries(capabilityLabels)) capabilityRows.push({label, value: capabilities[key]});
  for (const group of ['pointer', 'hover', 'display']) {
    for (const [key, value] of Object.entries(capabilities[group] || {})) {
      const label = `${group[0].toUpperCase()}${group.slice(1)} · ${key}`;
      capabilityRows.push({label, value});
    }
  }
  addCard(signals, 'Browser capabilities', capabilityRows, {wide: true, icon: '⌬'});

  const wallets = d.extra?.wallets || {};
  const walletRows = [
    {label: 'EVM wallets', value: wallets.evm?.length ? wallets.evm.map(wallet => wallet.name) : 'None detected'},
    {label: 'Solana wallets', value: wallets.solana?.length ? wallets.solana.map(wallet => wallet.name) : 'None detected'},
  ];
  addCard(signals, 'Wallets', walletRows, {icon: '◇'});

  addSectionHeading(entityContent, 'WebRTC geolocation', 'Each public candidate is located separately and compared with the server IP.');
  const geoGrid = document.createElement('div');
  geoGrid.className = 'entity-grid';
  entityContent.append(geoGrid);
  const geoCard = addCard(geoGrid, 'WebRTC IP locations', [], {wide: true, icon: '⌖'});
  const geoList = document.createElement('div');
  geoList.className = 'geo-list';
  const geoResults = ipLookups;
  if (!geoResults.length) {
    const empty = document.createElement('div');
    empty.className = 'notice';
    empty.textContent = ipLookupError
      ? 'WebRTC IP geolocation could not be loaded.'
      : webrtcIps.length
        ? 'No public WebRTC IP was available for geolocation.'
        : d.extra?.webrtc?.supported
          ? 'No WebRTC IP candidate was detected.'
          : 'WebRTC is not supported by this browser.';
    geoList.append(empty);
  }
  for (const result of geoResults) {
    const item = document.createElement('div');
    item.className = 'geo-item';
    const itemHead = document.createElement('div');
    itemHead.className = 'geo-item-head';
    const ip = document.createElement('span');
    ip.className = 'geo-ip';
    ip.textContent = result.ip;
    const canCompare = serverData.ip && serverData.ip !== 'Unknown';
    const isSame = result.matchesServer;
    const badge = document.createElement('span');
    badge.className = `badge ${!canCompare ? 'unknown' : isSame ? 'match' : 'diff'}`;
    badge.textContent = !canCompare ? 'Cannot compare' : isSame ? 'Same as server' : 'Different from server';
    itemHead.append(ip, badge);
    item.append(itemHead);
    const response = result.response;
    const place = document.createElement('div');
    place.className = 'geo-place';
    if (response?.success === true) {
      place.textContent = [response.city, response.region, response.country, response.timezone?.id].filter(Boolean).join(' · ') || 'Location not available';
    } else {
      place.textContent = result.public ? 'Location not available' : 'Local or non-public address; no location lookup';
    }
    item.append(place);
    geoList.append(item);
  }
  geoCard.append(geoList);
}

async function lookupWebRTCLocations(d) {
  const ips = d.extra?.webrtc?.ips || [];
  if (!ips.length) return {results: []};
  const response = await fetch('/api/webrtc-geolocation', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({serverIp: serverData.ip, ips}),
  });
  if (!response.ok) throw new Error(`Geolocation request failed (${response.status})`);
  return response.json();
}

collect().then(async d => {
  rawClient.textContent = JSON.stringify(d, null, 2);
  rawIp.textContent = JSON.stringify({server: initialIpData.server, webrtc: []}, null, 2);
  renderOverview(d);
  try {
    const result = await lookupWebRTCLocations(d);
    const locations = result.results || [];
    rawIp.textContent = JSON.stringify({server: initialIpData.server, webrtc: locations}, null, 2);
    renderOverview(d, locations);
  } catch (error) {
    const errorData = {error: String(error), results: []};
    rawIp.textContent = JSON.stringify({server: initialIpData.server, webrtc: errorData}, null, 2);
    renderOverview(d, [], error);
  }
}).catch(error => {
  rawClient.textContent = JSON.stringify({error: String(error)}, null, 2);
  entityContent.replaceChildren();
  const message = document.createElement('div');
  message.className = 'loading';
  message.textContent = 'Browser data could not be collected.';
  entityContent.append(message);
  console.error(error);
});
