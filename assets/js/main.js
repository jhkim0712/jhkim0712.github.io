// XOR + Base64 로 인코딩된 문자열을 복원
function _ds(s, k) {
    const raw = atob(s);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ k);
    }
    return out;
}

const CONFIG = (function() {
    const K = 0x5C;
    return {
        owner: _ds('NjQ3NTFsa21u', K),
        repo: _ds('NjQ3NTFsa21ucjs1KDQpPnI1Mw==', K),
        branch: _ds('MT01Mg==', K),
        manifestPath: _ds('KC49PzcvcjYvMzI=', K)
    };
})();

//* plain:
/*

 const CONFIG = {
     owner: 'github-username',
     repo: 'github-username.github.io',
     branch: 'main',
     manifestPath: 'tracks.json'
 };

*/


// 홈 위치 보호용 디코이(가짜) 경로 설정
// - center: 가리고 싶은 실제 좌표 부근(약간 어긋난 중심점을 사용)
//   * 평문 좌표 노출 방지를 위해 XOR + Base64 로 인코딩되어 보관됨
// - radiusKm: 디코이가 흩어지는 대략적 반경(km)
function _d(s, k) {
    const raw = atob(s);
    const buf = new ArrayBuffer(raw.length);
    const view = new DataView(buf);
    for (let i = 0; i < raw.length; i++) {
        view.setUint8(i, raw.charCodeAt(i) ^ k);
    }
    return [view.getFloat64(0, false), view.getFloat64(8, false)];
}

const HOME_OBFUSCATION = {
    center: _d('5ecxY0qYn7jl+mEwrjD63Q==', 0xA5),
    radiusKm: 0.2,
    count: 6,
    seed: 20260512
};

// 경량 미리보기(overview) 좌표 파일. scripts/build-track-overview.js 로 생성됨.
// GPX 원본(수천~수만 포인트)을 전부 내려받는 대신, 여기서 미리 단순화해둔
// 좌표(트랙당 최대 ~220개)만 먼저 그려서 첫 화면을 즉시 띄우고, 정밀 경로는
// 유휴 시간에 순차적으로(또는 클릭 시 즉시) 백그라운드로 불러온다.
const OVERVIEW_PATH = 'assets/data/track-overview.json';

const map = L.map('map').setView([36.5, 127.5], 7);
const searchInput = document.getElementById('search-input');
const trackListEl = document.getElementById('track-list');
const statusEl = document.getElementById('status');

let allTracks = [];
let activeTrackPath = null;
let detailLoadedCount = 0;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);

// --- 홈 위치 난독화 디코이 경로 ----------------------------------------------
function makeSeededRandom(seed) {
    let s = seed >>> 0;
    return function() {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

function offsetLatLng(centerLat, centerLng, dxKm, dyKm) {
    const dLat = dyKm / 111.32;
    const dLng = dxKm / (111.32 * Math.cos(centerLat * Math.PI / 180));
    return [centerLat + dLat, centerLng + dLng];
}

function buildDecoyPath(rand, center, radiusKm) {
    const startAngle = rand() * Math.PI * 2;
    const startR = (0.3 + rand() * 0.7) * radiusKm;
    let x = Math.cos(startAngle) * startR;
    let y = Math.sin(startAngle) * startR;

    const points = [offsetLatLng(center[0], center[1], x, y)];
    const steps = 25 + Math.floor(rand() * 25);
    let heading = rand() * Math.PI * 2;
    const stepKm = (0.15 + rand() * 0.25);

    for (let i = 0; i < steps; i++) {
        heading += (rand() - 0.5) * 0.9;
        x += Math.cos(heading) * stepKm;
        y += Math.sin(heading) * stepKm;
        // 반경을 너무 벗어나면 중심 쪽으로 살짝 끌어당김
        const dist = Math.sqrt(x * x + y * y);
        if (dist > radiusKm) {
            x *= radiusKm / dist * 0.95;
            y *= radiusKm / dist * 0.95;
            heading += Math.PI;
        }
        points.push(offsetLatLng(center[0], center[1], x, y));
    }
    return points;
}

function addDecoyRoutes(config) {
    const rand = makeSeededRandom(config.seed);
    const layerGroup = L.layerGroup();
    for (let i = 0; i < config.count; i++) {
        const latlngs = buildDecoyPath(rand, config.center, config.radiusKm);
        L.polyline(latlngs, {
            color: '#3388ff',
            weight: 4,
            opacity: 0.55,
            interactive: false
        }).addTo(layerGroup);
    }
    layerGroup.addTo(map);
}

addDecoyRoutes(HOME_OBFUSCATION);
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

// --- Relive 기록(동영상/사진) 오버레이 -------------------------------------
let reliveOverlayEl = null;

function ensureReliveOverlay() {
    if (reliveOverlayEl) return reliveOverlayEl;

    const overlay = document.createElement('div');
    overlay.className = 'relive-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'relive-modal';

    const header = document.createElement('div');
    header.className = 'relive-modal-header';

    const title = document.createElement('div');
    title.className = 'relive-modal-title';
    title.id = 'relive-modal-title';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'relive-modal-close';
    closeBtn.innerText = '✕';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.onclick = closeReliveOverlay;

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'relive-modal-body';

    const iframe = document.createElement('iframe');
    iframe.id = 'relive-modal-iframe';
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';
    body.appendChild(iframe);

    const footer = document.createElement('div');
    footer.className = 'relive-modal-footer';

    const hint = document.createElement('span');
    hint.innerText = '화면이 보이지 않으면 새 탭에서 열어보세요.';

    const link = document.createElement('a');
    link.id = 'relive-modal-link';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerText = 'Relive.cc에서 새 탭으로 열기 ↗';

    footer.appendChild(hint);
    footer.appendChild(link);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeReliveOverlay();
    });

    document.body.appendChild(overlay);
    reliveOverlayEl = overlay;
    return overlay;
}

function openReliveOverlay(track) {
    if (!track.relive) return;
    const overlay = ensureReliveOverlay();
    overlay.querySelector('#relive-modal-title').innerText = `🎬 ${getDisplayTitle(track)}`;
    overlay.querySelector('#relive-modal-iframe').src = track.relive;
    overlay.querySelector('#relive-modal-link').href = track.relive;
    overlay.hidden = false;
    document.addEventListener('keydown', handleReliveOverlayKeydown);
}

function closeReliveOverlay() {
    if (!reliveOverlayEl || reliveOverlayEl.hidden) return;
    reliveOverlayEl.hidden = true;
    // 닫을 때 iframe 소스를 비워 재생 중인 영상/오디오를 정지시킴
    reliveOverlayEl.querySelector('#relive-modal-iframe').src = '';
    document.removeEventListener('keydown', handleReliveOverlayKeydown);
}

function handleReliveOverlayKeydown(e) {
    if (e.key === 'Escape') closeReliveOverlay();
}
// ---------------------------------------------------------------------------

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
        if (!track.layer) return;
        const isActive = track.path === activeTrackPath;
        const item = track.listItem;
        if (item) {
            item.classList.toggle('active', isActive);
        }
        track.layer.setStyle({
            color: isActive ? '#ff5a36' : '#3388ff',
            weight: isActive ? 7 : 4,
            opacity: isActive ? 1 : 0.65
        });
    });
}

async function fetchTrackManifest() {
    const response = await fetch(`./${CONFIG.manifestPath}?t=${Date.now()}`);

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
            layer: null,
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

    if (track.bike || track.relive) {
        const badgeRow = document.createElement('div');
        badgeRow.className = 'track-badge-row';

        if (track.bike) {
            const bikeEl = document.createElement('span');
            bikeEl.className = 'track-bike';
            bikeEl.innerText = `🏍️ ${track.bike}`;
            badgeRow.appendChild(bikeEl);
        }

        if (track.relive) {
            const reliveBtn = document.createElement('button');
            reliveBtn.type = 'button';
            reliveBtn.className = 'track-relive-btn';
            reliveBtn.innerText = '🎬 Relive 보기';
            reliveBtn.onclick = (e) => {
                e.stopPropagation();
                openReliveOverlay(track);
            };
            badgeRow.appendChild(reliveBtn);
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

// 단순화된 좌표로 가벼운 미리보기 폴리라인을 그림 (즉시 표시용)
function createOverviewLayer(track) {
    const layer = L.polyline(track.overview.points, {
        color: '#3388ff',
        weight: 4,
        opacity: 0.65
    });
    track.layer = layer;
    attachLayerEvents(track, layer);
    layer.addTo(map);
}

function fitToTrack(track) {
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

            track.layer = layer;
            track.detail = true;
            attachLayerEvents(track, layer, tooltipText);

            if (previousLayer && previousLayer !== layer && map.hasLayer(previousLayer)) {
                map.removeLayer(previousLayer);
            }
            if (activeTrackPath === track.path) {
                setActiveTrack(activeTrackPath);
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
            if (overview && Array.isArray(overview.points) && overview.points.length >= 2) {
                track.overview = overview;
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

init();
