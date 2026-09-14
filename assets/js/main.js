// XOR + Base64 로 인코딩된 문자열을 복원
function _ds(s, k) {
    const raw = atob(s);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ k);
    }
    return out;
}

// 홈 위치 보호용 반경 좌표 복원
// - center: 가리고 싶은 실제 좌표 부근(약간 어긋난 중심점을 사용)
//   * 평문 좌표 노출 방지를 위해 config.json에는 XOR + Base64로 인코딩되어 보관됨
function _d(s, k) {
    const raw = atob(s);
    const buf = new ArrayBuffer(raw.length);
    const view = new DataView(buf);
    for (let i = 0; i < raw.length; i++) {
        view.setUint8(i, raw.charCodeAt(i) ^ k);
    }
    return [view.getFloat64(0, false), view.getFloat64(8, false)];
}

// 퍼시스턴트 설정값(GitHub 정보, 홈 위치 반경, API 키 등)은 전부 루트의
// config.json 에서 읽어온다. 형식은 config.json 참고:
//
//   {
//     "github": { "owner": "...", "repo": "...", "branch": "...", "manifestPath": "..." },
//     "homeObfuscation": { "center": "...", "radiusKm": 0.2 },
//     "vworld": { "apiKey": "...", "issuedAt": "...", "expiresAt": "..." },
//     "naver": { "apiKeyId": "...", "issuedAt": "...", "expiresAt": "..." },
//     "overviewPath": "assets/data/track-overview.json",
//     "defaultBasemap": "osm"
//   }
//
// github.*, homeObfuscation.center 는 XOR + Base64로 인코딩된 값이며, 위 _ds/_d 로 복원한다.
let CONFIG = null;
let HOME_OBFUSCATION = null;
let VWORLD_API_KEY = 'VWORLD_API_KEY';
let NAVER_API_KEY_ID = 'NAVER_API_KEY_ID';
let OVERVIEW_PATH = 'assets/data/track-overview.json';
let DEFAULT_BASEMAP = 'osm';
let baseLayers = null;
// 'leaflet'(OSM/VWorld) 또는 'naver' — 현재 화면에 보이는 지도 엔진
let activeEngine = 'leaflet';
let naverMap = null;
let naverTooltip = null;
let naverSdkLoadPromise = null;

const DEFAULT_MANIFEST_PATH = 'tracks.json';
const BASEMAP_STORAGE_KEY = 'ridingArchive.basemap';
const VIEW_MODE_STORAGE_KEY = 'ridingArchive.viewMode';

const map = L.map('map').setView([36.5, 127.5], 7);
const mapEl = map.getContainer();
const naverMapEl = document.getElementById('map-naver');
const searchInput = document.getElementById('search-input');
const trackListEl = document.getElementById('track-list');
const statusEl = document.getElementById('status');
const basemapSelect = document.getElementById('basemap-select');
const basemapHintEl = document.getElementById('basemap-hint');
const viewModeToggleEl = document.getElementById('view-mode-toggle');

let allTracks = [];
let activeTrackPath = null;
let detailLoadedCount = 0;
// 'all' = 모든 경로를 지도에 표시, 'selected' = 선택(활성)된 경로만 표시
let viewMode = 'all';

async function loadAppConfig() {
    const response = await fetch(`./config.json?t=${Date.now()}`);
    if (!response.ok) {
        throw new Error(`config.json 로드 실패: ${response.status}`);
    }
    return response.json();
}

function applyAppConfig(raw) {
    const K = 0x5C;
    CONFIG = {
        owner: _ds(raw.github.owner, K),
        repo: _ds(raw.github.repo, K),
        branch: _ds(raw.github.branch, K),
        manifestPath: _ds(raw.github.manifestPath, K)
    };

    HOME_OBFUSCATION = {
        center: _d(raw.homeObfuscation.center, 0xA5),
        radiusKm: raw.homeObfuscation.radiusKm
    };

    VWORLD_API_KEY = (raw.vworld && raw.vworld.apiKey) || 'VWORLD_API_KEY';
    NAVER_API_KEY_ID = (raw.naver && raw.naver.apiKeyId) || 'NAVER_API_KEY_ID';
    OVERVIEW_PATH = raw.overviewPath || OVERVIEW_PATH;
    DEFAULT_BASEMAP = raw.defaultBasemap || DEFAULT_BASEMAP;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// --- 배경지도 선택 (OSM / VWorld / 네이버지도) --------------------------------
// 브이월드(VWorld, 국토교통부 국토지리정보원) 오픈API 인증키는 config.json의
// vworld.apiKey 에서 읽어온다. www.vworld.kr 에서 무료로 발급받은 키로 교체해야
// VWorld 타일이 표시됨 (발급 방법은 README.md 참고). 키를 넣기 전까지 VWorld를
// 선택하면 빈 타일과 함께 안내 문구가 뜨고, OSM은 그대로 잘 동작함.
//
// 네이버지도는 OSM/VWorld와 달리 Leaflet이 쓸 수 있는 공개 XYZ 타일이 없고,
// 네이버 Maps JS SDK(v3)가 자체적으로 그리는 별도의 지도 div(#map-naver)로만
// 제공된다. 그래서 OSM/VWorld ↔ 네이버지도 전환은 Leaflet 타일 교체가 아니라
// #map / #map-naver 두 div의 표시를 서로 바꾸는 방식으로 동작한다. 트랙 경로는
// Leaflet 쪽에서 파싱한 좌표(track.layer)를 그대로 재사용해 네이버 폴리라인으로
// 미러링한다(syncNaverTrack) — GPX를 두 번 파싱하지 않는다.
function setBasemapHint(text) {
    if (!basemapHintEl) return;
    if (!text) {
        basemapHintEl.hidden = true;
        basemapHintEl.innerText = '';
        return;
    }
    basemapHintEl.hidden = false;
    basemapHintEl.innerText = text;
}

// 네이버 Maps JS SDK를 최초 1회만 <script> 태그로 동적 로드
function loadNaverSdk() {
    if (naverSdkLoadPromise) return naverSdkLoadPromise;

    naverSdkLoadPromise = new Promise((resolve, reject) => {
        window.navermap_authFailure = function () {
            reject(new Error('네이버 지도 인증 실패'));
        };
        window.__onNaverMapsReady = () => resolve();

        const script = document.createElement('script');
        script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NAVER_API_KEY_ID}&callback=__onNaverMapsReady`;
        script.onerror = () => reject(new Error('네이버 지도 SDK 로드 실패'));
        document.head.appendChild(script);
    });

    return naverSdkLoadPromise;
}

// 네이버 지도 인스턴스를 최초 1회만 생성하고, 이미 표시 중인 트랙들을 옮겨 그린다
async function ensureNaverMap() {
    if (naverMap) return naverMap;
    if (!NAVER_API_KEY_ID || NAVER_API_KEY_ID === 'NAVER_API_KEY_ID') {
        throw new Error('naver.apiKeyId가 설정되지 않음');
    }

    await loadNaverSdk();

    naverMap = new naver.maps.Map(naverMapEl, {
        center: new naver.maps.LatLng(36.5, 127.5),
        zoom: 7
    });
    naverTooltip = new naver.maps.InfoWindow({
        content: '',
        disableAnchor: true,
        backgroundColor: 'transparent',
        borderWidth: 0
    });

    allTracks.forEach(syncNaverTrack);
    return naverMap;
}

// Leaflet 폴리라인(child)들의 좌표를 네이버 LatLng 배열(구간별)로 변환
function buildNaverPathsFromLeafletLayer(layer) {
    const paths = [];
    if (!layer || typeof layer.eachLayer !== 'function') return paths;

    layer.eachLayer(child => {
        if (typeof child.getLatLngs !== 'function') return;
        const latlngs = child.getLatLngs();
        if (latlngs.length === 0) return;
        const segments = Array.isArray(latlngs[0]) ? latlngs : [latlngs];
        segments.forEach(seg => {
            if (seg.length >= 2) paths.push(seg.map(p => new naver.maps.LatLng(p.lat, p.lng)));
        });
    });

    return paths;
}

function applyNaverTrackStyle(track) {
    if (!track.naverLayer) return;
    const isActive = activeTrackPath === track.path;
    track.naverLayer.polylines.forEach(pl => pl.setOptions({
        strokeColor: isActive ? '#ff5a36' : '#3388ff',
        strokeWeight: isActive ? 7 : 4,
        strokeOpacity: isActive ? 1 : 0.65
    }));
}

function updateNaverTrackVisibility(track) {
    if (!track.naverLayer) return;
    const shouldShow = viewMode === 'all' || track.path === activeTrackPath;
    track.naverLayer.polylines.forEach(pl => pl.setMap(shouldShow ? naverMap : null));
}

// 지도 위 경로에 hover 강조·툴팁·클릭 동작을 연결 (attachLayerEvents의 네이버판)
function attachNaverPolylineEvents(track, polyline) {
    const text = getTooltipText(track);

    naver.maps.Event.addListener(polyline, 'mouseover', function (e) {
        const isActive = activeTrackPath === track.path;
        track.naverLayer.polylines.forEach(pl => pl.setOptions({
            strokeColor: '#ff5a36',
            strokeWeight: isActive ? 7 : 6,
            strokeOpacity: 1
        }));
        if (naverTooltip) {
            naverTooltip.setContent(`<div class="custom-tooltip">${escapeHtml(text)}</div>`);
            const at = (e && e.coord) || polyline.getPath().getAt(0);
            naverTooltip.open(naverMap, at);
        }
    });

    naver.maps.Event.addListener(polyline, 'mouseout', function () {
        applyNaverTrackStyle(track);
        if (naverTooltip) naverTooltip.close();
    });

    naver.maps.Event.addListener(polyline, 'click', function () {
        focusTrack(track);
    });
}

// track.layer(Leaflet, 이미 홈 반경 마스킹까지 끝난 상태)를 기준으로 네이버
// 폴리라인을 새로 그린다. 개요→정밀 경로로 교체될 때마다 다시 호출해서 갱신한다.
function syncNaverTrack(track) {
    if (!naverMap || !track.layer) return;

    if (track.naverLayer) {
        track.naverLayer.polylines.forEach(pl => pl.setMap(null));
    }

    const polylines = buildNaverPathsFromLeafletLayer(track.layer).map(path => new naver.maps.Polyline({
        path,
        strokeColor: '#3388ff',
        strokeWeight: 4,
        strokeOpacity: 0.65
    }));
    polylines.forEach(pl => attachNaverPolylineEvents(track, pl));

    track.naverLayer = { polylines };
    applyNaverTrackStyle(track);
    updateNaverTrackVisibility(track);
}

function naverFitToTrack(track) {
    if (!naverMap || !track.naverLayer || track.naverLayer.polylines.length === 0) return;
    const bounds = new naver.maps.LatLngBounds();
    let hasPoint = false;
    track.naverLayer.polylines.forEach(pl => {
        pl.getPath().forEach(pt => {
            bounds.extend(pt);
            hasPoint = true;
        });
    });
    if (hasPoint) naverMap.fitBounds(bounds);
}

async function setBasemap(key) {
    const requestedKey = key;
    if (key !== 'naver' && !baseLayers[key]) key = DEFAULT_BASEMAP;

    let naverError = null;
    if (key === 'naver') {
        try {
            await ensureNaverMap();
        } catch (e) {
            console.error('네이버 지도를 불러오지 못했습니다:', e);
            naverError = e;
            key = DEFAULT_BASEMAP;
        }
    }

    activeEngine = key === 'naver' ? 'naver' : 'leaflet';

    if (activeEngine === 'naver') {
        mapEl.hidden = true;
        naverMapEl.hidden = false;

        const activeTrack = allTracks.find(t => t.path === activeTrackPath);
        if (activeTrack) naverFitToTrack(activeTrack);
    } else {
        naverMapEl.hidden = true;
        mapEl.hidden = false;
        // #map이 hidden인 동안에는 크기를 0으로 인식하므로 다시 보일 때 갱신해줘야 함
        setTimeout(() => map.invalidateSize(), 0);

        Object.values(baseLayers).forEach(layer => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        baseLayers[key].addTo(map);
    }

    if (basemapSelect) basemapSelect.value = key;

    if (requestedKey === 'naver' && naverError) {
        setBasemapHint(NAVER_API_KEY_ID === 'NAVER_API_KEY_ID'
            ? '네이버지도를 쓰려면 config.json의 naver.apiKeyId에 발급받은 Client ID를 넣어야 합니다 (README 참고).'
            : '네이버 지도를 불러오지 못했습니다. config.json의 naver.apiKeyId와 NCP 콘솔의 Web 서비스 URL 등록을 확인하세요 (README 참고, 자세한 원인은 콘솔 로그 참고).');
    } else if (key === 'vworld' && VWORLD_API_KEY === 'VWORLD_API_KEY') {
        setBasemapHint('VWorld를 쓰려면 config.json의 vworld.apiKey에 발급받은 API 키를 넣어야 합니다 (README 참고).');
    } else {
        setBasemapHint('');
    }

    try {
        localStorage.setItem(BASEMAP_STORAGE_KEY, key);
    } catch (e) {
        // 시크릿 모드 등에서 localStorage 접근이 막혀도 지도 전환 자체는 계속 동작해야 함
    }
}

function setupBasemapLayers() {
    baseLayers = {
        osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }),
        vworld: L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_API_KEY}/Base/{z}/{y}/{x}.png`, {
            attribution: '© VWorld',
            maxZoom: 19,
            minZoom: 6
        })
    };

    let vworldTileErrorWarned = false;
    baseLayers.vworld.on('tileerror', () => {
        if (vworldTileErrorWarned) return;
        vworldTileErrorWarned = true;
        console.error('VWorld 타일 로드 실패: config.json의 vworld.apiKey를 발급받은 인증키로 교체했는지, 도메인이 등록됐는지 확인하세요.');
        if (basemapSelect && basemapSelect.value === 'vworld') {
            setBasemapHint('VWorld 타일을 불러오지 못했습니다. config.json의 vworld.apiKey 설정을 확인하세요 (README 참고).');
        }
    });

    let savedBasemap = null;
    try {
        savedBasemap = localStorage.getItem(BASEMAP_STORAGE_KEY);
    } catch (e) {
        savedBasemap = null;
    }

    setBasemap((savedBasemap === 'naver' || baseLayers[savedBasemap]) ? savedBasemap : DEFAULT_BASEMAP);

    if (basemapSelect) {
        basemapSelect.addEventListener('change', () => setBasemap(basemapSelect.value));
    }
}
// ---------------------------------------------------------------------------

// --- 경로 표시 범위 (전체 경로 보기 / 선택 경로만 보기) -----------------------
// 처음 로드 시에는 모든 경로를 지도에 보여주고, 사용자가 원하면 선택(활성)된
// 경로 하나만 남기고 나머지는 지도에서 숨길 수 있게 한다.
function updateTrackLayerVisibility(track) {
    updateNaverTrackVisibility(track);

    if (!track.layer) return;
    const shouldShow = viewMode === 'all' || track.path === activeTrackPath;
    const isShown = map.hasLayer(track.layer);
    if (shouldShow && !isShown) {
        track.layer.addTo(map);
    } else if (!shouldShow && isShown) {
        map.removeLayer(track.layer);
    }
}

function applyViewModeToAllTracks() {
    allTracks.forEach(updateTrackLayerVisibility);
    if (viewMode === 'selected') {
        const activeTrack = allTracks.find(track => track.path === activeTrackPath);
        if (activeTrack) fitToTrack(activeTrack);
    }
}

function setViewMode(mode) {
    viewMode = mode === 'selected' ? 'selected' : 'all';

    if (viewModeToggleEl) {
        viewModeToggleEl.querySelectorAll('.view-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === viewMode);
        });
    }

    applyViewModeToAllTracks();

    try {
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch (e) {
        // 시크릿 모드 등에서 localStorage 접근이 막혀도 모드 전환 자체는 계속 동작해야 함
    }
}

function setupViewModeToggle() {
    let savedViewMode = null;
    try {
        savedViewMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    } catch (e) {
        savedViewMode = null;
    }
    viewMode = savedViewMode === 'selected' ? 'selected' : 'all';

    if (viewModeToggleEl) {
        viewModeToggleEl.querySelectorAll('.view-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === viewMode);
            btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
        });
    }
}
// ---------------------------------------------------------------------------

// --- 홈 위치 반경 내 경로 숨김 ------------------------------------------------
// 가짜 디코이 경로로 홈 위치를 가리는 대신, 홈 반경(HOME_OBFUSCATION) 안에 들어오는
// 구간은 지도에 아예 그리지 않는다(그 지점에서 선을 끊음). 개요 경로는 빌드 스크립트
// (scripts/build-track-overview.js)가 반경 내 좌표를 미리 제거해두므로, 여기서는
// 원본 GPX를 그대로 불러오는 정밀 경로만 다듬으면 된다.
function isNearHome(lat, lng) {
    if (!HOME_OBFUSCATION) return false;
    const [centerLat, centerLng] = HOME_OBFUSCATION.center;
    return L.latLng(lat, lng).distanceTo(L.latLng(centerLat, centerLng)) <= HOME_OBFUSCATION.radiusKm * 1000;
}

// 좌표 배열(중첩 배열도 허용)에서 홈 반경 내 지점을 제거하고, 끊어진 자리마다
// 구간을 나눠서 돌려준다(구간 사이는 선으로 잇지 않음)
function splitAwayFromHome(latlngs) {
    if (latlngs.length > 0 && Array.isArray(latlngs[0])) {
        return latlngs.reduce((acc, sub) => acc.concat(splitAwayFromHome(sub)), []);
    }

    const segments = [];
    let current = [];
    latlngs.forEach(pt => {
        const lat = Array.isArray(pt) ? pt[0] : pt.lat;
        const lng = Array.isArray(pt) ? pt[1] : pt.lng;
        if (isNearHome(lat, lng)) {
            if (current.length > 1) segments.push(current);
            current = [];
        } else {
            current.push(pt);
        }
    });
    if (current.length > 1) segments.push(current);
    return segments;
}

// 정밀 경로(leaflet-gpx) 레이어 내부의 선(폴리라인)들에서 홈 반경 구간을 제거
function maskHomeAreaOnLayer(gpxLayer) {
    if (!HOME_OBFUSCATION) return;
    gpxLayer.eachLayer(child => {
        if (typeof child.getLatLngs !== 'function' || typeof child.setLatLngs !== 'function') return;
        const segments = splitAwayFromHome(child.getLatLngs());
        if (segments.length === 0) {
            gpxLayer.removeLayer(child);
        } else {
            child.setLatLngs(segments);
        }
    });
}
// ---------------------------------------------------------------------------

function buildRawFileUrl(path) {
    return `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${path}`;
}

function getDisplayTitle(track) {
    return track.title || track.path.split('/').pop();
}

function getMetaText(track) {
    const meta = [];
    if (track.date) meta.push(track.date);
    if (track.region) meta.push(track.region);
    return meta.join(' · ');
}

function getTooltipText(track) {
    const title = getDisplayTitle(track);
    const parts = [title];
    if (track.bike) parts.push(`[${track.bike}]`);
    const head = parts.join(' ');
    return track.description ? `${head} - ${track.description}` : head;
}

function getTrackYear(track) {
    if (track.date && /^\d{4}/.test(track.date)) {
        return track.date.slice(0, 4);
    }
    const match = track.path.match(/^tracks\/(\d{4})\//);
    return match ? match[1] : '기타';
}

function matchesSearch(track, keyword) {
    if (!keyword) return true;
    const haystack = [
        track.path,
        track.title,
        track.description,
        track.date,
        track.region,
        track.bike
    ].join(' ').toLowerCase();
    return haystack.includes(keyword.toLowerCase());
}

function setActiveTrack(path) {
    activeTrackPath = path;
    allTracks.forEach(track => {
        const isActive = track.path === activeTrackPath;
        const item = track.listItem;
        if (item) {
            item.classList.toggle('active', isActive);
        }
        applyNaverTrackStyle(track);
        if (!track.layer) return;
        track.layer.setStyle({
            color: isActive ? '#ff5a36' : '#3388ff',
            weight: isActive ? 7 : 4,
            opacity: isActive ? 1 : 0.65
        });
        updateTrackLayerVisibility(track);
    });
}

async function fetchTrackManifest() {
    const manifestPath = (CONFIG && CONFIG.manifestPath) || DEFAULT_MANIFEST_PATH;
    const response = await fetch(`./${manifestPath}?t=${Date.now()}`);

    if (!response.ok) {
        throw new Error(`tracks.json 로드 실패: ${response.status}`);
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
        throw new Error('tracks.json 형식이 올바르지 않습니다.');
    }

    return items
        .filter(item => item.path && item.path.toLowerCase().endsWith('.gpx'))
        .map(item => ({
            path: item.path,
            title: item.title || '',
            description: item.description || '',
            date: item.date || '',
            region: item.region || '',
            bike: item.bike || '',
            relive: item.relive || '',
            url: buildRawFileUrl(item.path),
            overview: null,
            distanceKm: null,
            layer: null,
            naverLayer: null,
            detail: false,
            detailPromise: null,
            listItem: null
        }))
        .sort((a, b) => {
            const dateA = a.date || '';
            const dateB = b.date || '';
            if (dateA !== dateB) return dateB.localeCompare(dateA);
            return b.path.localeCompare(a.path);
        });
}

async function fetchTrackOverview() {
    try {
        const response = await fetch(`./${OVERVIEW_PATH}?t=${Date.now()}`);
        if (!response.ok) return {};
        return await response.json();
    } catch (e) {
        console.warn('track-overview.json 로드 실패, 개별 GPX를 바로 불러옵니다.', e);
        return {};
    }
}

function createTrackListItem(track) {
    const item = document.createElement('div');
    item.className = 'track-item';

    const titleEl = document.createElement('div');
    titleEl.className = 'track-title';
    titleEl.innerText = getDisplayTitle(track);

    const metaEl = document.createElement('div');
    metaEl.className = 'track-meta';
    metaEl.innerText = getMetaText(track) || track.path.replace('tracks/', '');

    const descEl = document.createElement('div');
    descEl.className = 'track-description';
    descEl.innerText = track.description || '설명이 없습니다.';

    item.appendChild(titleEl);
    item.appendChild(metaEl);

    if (track.bike || track.relive || track.distanceKm != null) {
        const badgeRow = document.createElement('div');
        badgeRow.className = 'track-badge-row';

        if (track.distanceKm != null) {
            const distEl = document.createElement('span');
            distEl.className = 'track-distance';
            distEl.innerText = `🛣️ ${track.distanceKm.toFixed(1)}km`;
            badgeRow.appendChild(distEl);
        }

        if (track.bike) {
            const bikeEl = document.createElement('span');
            bikeEl.className = 'track-bike';
            bikeEl.innerText = `🏍️ ${track.bike}`;
            badgeRow.appendChild(bikeEl);
        }

        if (track.relive) {
            // relive.com/.cc는 X-Frame-Options: DENY 로 자기 자신 외의 페이지에서
            // iframe으로 여는 걸 막아둬서(실제로 확인됨) 지도 위 오버레이로는 띄울 수
            // 없음. 그래서 새 탭에서 바로 여는 링크로 제공.
            const reliveLink = document.createElement('a');
            reliveLink.className = 'track-relive-btn';
            reliveLink.href = track.relive;
            reliveLink.target = '_blank';
            reliveLink.rel = 'noopener noreferrer';
            reliveLink.innerText = '🎬 Relive 새 탭에서 보기 ↗';
            reliveLink.onclick = (e) => e.stopPropagation();
            badgeRow.appendChild(reliveLink);
        }

        item.appendChild(badgeRow);
    }

    item.appendChild(descEl);

    item.onclick = () => {
        focusTrack(track);
    };

    track.listItem = item;
    return item;
}

function renderTrackList() {
    const keyword = searchInput.value.trim().toLowerCase();
    trackListEl.innerHTML = '';

    const filteredTracks = allTracks.filter(track => matchesSearch(track, keyword));

    if (filteredTracks.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'empty-message';
        emptyEl.innerText = '검색 결과가 없습니다.';
        trackListEl.appendChild(emptyEl);
        return;
    }

    const groups = new Map();
    filteredTracks.forEach(track => {
        const year = getTrackYear(track);
        if (!groups.has(year)) groups.set(year, []);
        groups.get(year).push(track);
    });

    Array.from(groups.keys())
        .sort((a, b) => b.localeCompare(a))
        .forEach(year => {
            const groupEl = document.createElement('div');
            groupEl.className = 'track-year-group';

            const headingEl = document.createElement('div');
            headingEl.className = 'track-year-heading';
            headingEl.innerText = year;
            groupEl.appendChild(headingEl);

            groups.get(year).forEach(track => {
                groupEl.appendChild(createTrackListItem(track));
            });

            trackListEl.appendChild(groupEl);
        });

    if (activeTrackPath) {
        setActiveTrack(activeTrackPath);
    }
}

// 지도 위 경로(개요/정밀 공통)에 hover 강조·툴팁·클릭 동작을 연결
function attachLayerEvents(track, layer, tooltipText) {
    const text = tooltipText || getTooltipText(track);

    layer.on('mouseover', function() {
        const isActive = activeTrackPath === track.path;
        this.setStyle({
            color: '#ff5a36',
            weight: isActive ? 7 : 6,
            opacity: 1
        });
        this.bindTooltip(text, {
            sticky: true,
            direction: 'top',
            className: 'custom-tooltip'
        }).openTooltip();
    });

    layer.on('mouseout', function() {
        const isActive = activeTrackPath === track.path;
        this.setStyle({
            color: isActive ? '#ff5a36' : '#3388ff',
            weight: isActive ? 7 : 4,
            opacity: isActive ? 1 : 0.65
        });
        this.closeTooltip();
    });

    layer.on('click', function() {
        focusTrack(track);
    });
}

// track-overview.json의 points는 구간 배열([[ [lat,lon], ... ], ...]) 형식이다(홈 반경으로
// 끊긴 구간이 여러 개일 수 있음). 재실행 전의 예전 파일(단일 좌표 배열)도 함께 지원한다.
function normalizeOverviewSegments(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    return Array.isArray(points[0][0]) ? points : [points];
}

function hasUsableOverviewPoints(overview) {
    if (!overview || !Array.isArray(overview.points)) return false;
    return normalizeOverviewSegments(overview.points).some(seg => Array.isArray(seg) && seg.length >= 2);
}

// 단순화된 좌표로 가벼운 미리보기 폴리라인을 그림 (즉시 표시용)
function createOverviewLayer(track) {
    const segments = normalizeOverviewSegments(track.overview.points);
    const layer = L.featureGroup(segments.map(seg => L.polyline(seg, {
        color: '#3388ff',
        weight: 4,
        opacity: 0.65
    })));
    track.layer = layer;
    attachLayerEvents(track, layer);
    updateTrackLayerVisibility(track);
    syncNaverTrack(track);
}

function fitToTrack(track) {
    if (activeEngine === 'naver') {
        naverFitToTrack(track);
        return;
    }
    if (track.layer && track.layer.getBounds) {
        const bounds = track.layer.getBounds();
        if (bounds && bounds.isValid()) {
            map.fitBounds(bounds);
            return;
        }
    }
    if (track.overview && track.overview.bounds) {
        const bounds = L.latLngBounds(track.overview.bounds);
        if (bounds.isValid()) map.fitBounds(bounds);
    }
}

// 목록/지도에서 트랙을 선택했을 때: 활성화 표시 + 화면 이동 + 정밀 경로를 즉시(대기열 순서와 무관하게) 요청
function focusTrack(track) {
    setActiveTrack(track.path);
    fitToTrack(track);
    loadFullDetail(track).then(() => {
        if (activeTrackPath === track.path) {
            fitToTrack(track);
        }
    });
}

function updateLoadStatus() {
    if (detailLoadedCount >= allTracks.length) {
        statusEl.innerText = `총 ${allTracks.length}개 투어 로드 완료`;
    } else {
        statusEl.innerText = `총 ${allTracks.length}개 투어 표시 중 · 정밀 경로 불러오는 중 (${detailLoadedCount}/${allTracks.length})`;
    }
}

// 원본 GPX(정밀 경로)를 불러와 개요 폴리라인을 교체. 이미 불러왔거나 불러오는 중이면 그 결과를 재사용.
function loadFullDetail(track) {
    if (track.detail) return Promise.resolve(track.layer);
    if (track.detailPromise) return track.detailPromise;

    track.detailPromise = new Promise((resolve) => {
        const tooltipText = getTooltipText(track);
        const gpxLayer = new L.GPX(track.url, {
            async: true,
            marker_options: {
                startIconUrl: null,
                endIconUrl: null,
                shadowUrl: null
            },
            polyline_options: {
                color: '#3388ff',
                weight: 4,
                opacity: 0.65
            }
        });

        gpxLayer.on('loaded', function(e) {
            const layer = e.target;
            const previousLayer = track.layer;

            // 원본 GPX는 홈 반경 내 좌표를 그대로 담고 있으므로, 지도에 표시하기 전에
            // 그 구간을 잘라낸다 (거리 계산에는 영향 없음 - get_distance()는 파싱 시점에
            // 이미 계산돼있음)
            maskHomeAreaOnLayer(layer);

            track.layer = layer;
            track.detail = true;
            attachLayerEvents(track, layer, tooltipText);
            syncNaverTrack(track);

            // 개요 데이터가 없어 distanceKm이 비어있던 트랙은 leaflet-gpx가 계산한
            // 거리로 채워준다 (다음 검색/렌더링 때 목록에 반영됨)
            if (track.distanceKm == null && typeof layer.get_distance === 'function') {
                track.distanceKm = Math.round((layer.get_distance() / 1000) * 10) / 10;
            }

            if (previousLayer && previousLayer !== layer && map.hasLayer(previousLayer)) {
                map.removeLayer(previousLayer);
            }
            if (activeTrackPath === track.path) {
                setActiveTrack(activeTrackPath);
            } else {
                updateTrackLayerVisibility(track);
            }

            detailLoadedCount++;
            updateLoadStatus();
            resolve(layer);
        });

        gpxLayer.on('error', function(err) {
            console.error('GPX load error:', track.path, err);
            detailLoadedCount++;
            updateLoadStatus();
            resolve(track.layer);
        });

        gpxLayer.addTo(map);
    });

    return track.detailPromise;
}

const requestIdle = window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (cb) => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: true }), 200);

// 브라우저 유휴 시간에 정밀 경로를 순차적으로(동시 2개까지) 백그라운드 로드
function scheduleBackgroundDetailLoad(tracks) {
    const queue = tracks.slice();
    const concurrency = 2;
    let active = 0;

    function pump() {
        while (active < concurrency && queue.length > 0) {
            const track = queue.shift();
            active++;
            requestIdle(() => {
                loadFullDetail(track).finally(() => {
                    active--;
                    pump();
                });
            });
        }
    }

    pump();
}

async function init() {
    try {
        const [manifestTracks, overviewData] = await Promise.all([
            fetchTrackManifest(),
            fetchTrackOverview()
        ]);

        allTracks = manifestTracks;

        if (allTracks.length === 0) {
            statusEl.innerText = 'tracks.json에 GPX 항목이 없습니다.';
            return;
        }

        const needsImmediateDetail = [];
        const queuedForBackground = [];

        allTracks.forEach((track, index) => {
            const overview = overviewData[track.path];
            if (hasUsableOverviewPoints(overview)) {
                track.overview = overview;
                track.distanceKm = typeof overview.distanceKm === 'number' ? overview.distanceKm : null;
                createOverviewLayer(track);
                queuedForBackground.push(track);
            } else {
                // 개요 데이터가 없는 트랙(빌드 스크립트 미실행 등)은 바로 정밀 경로를 불러옴
                needsImmediateDetail.push(track);
            }

            if (index === 0) {
                focusTrack(track);
            }
        });

        renderTrackList();
        statusEl.innerText = allTracks.length === queuedForBackground.length
            ? `총 ${allTracks.length}개 투어 표시 중 · 정밀 경로 불러오는 중 (0/${allTracks.length})`
            : `총 ${allTracks.length}개 투어 로드 중…`;

        needsImmediateDetail.forEach(track => loadFullDetail(track));
        scheduleBackgroundDetailLoad(queuedForBackground);
    } catch (e) {
        console.error(e);
        statusEl.innerText = 'tracks.json 또는 GPX 파일을 불러오지 못했습니다.';
    }
}

searchInput.addEventListener('input', renderTrackList);

async function bootstrap() {
    let raw;
    try {
        raw = await loadAppConfig();
    } catch (e) {
        console.error(e);
        statusEl.innerText = 'config.json을 불러오지 못했습니다.';
        return;
    }

    applyAppConfig(raw);
    setupBasemapLayers();
    setupViewModeToggle();
    init();
}

bootstrap();
