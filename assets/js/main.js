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

const map = L.map('map').setView([36.5, 127.5], 7);
const searchInput = document.getElementById('search-input');
const trackListEl = document.getElementById('track-list');
const statusEl = document.getElementById('status');

let allTracks = [];
let activeTrackPath = null;

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
            url: buildRawFileUrl(item.path),
            layer: null,
            listItem: null
        }))
        .sort((a, b) => {
            const dateA = a.date || '';
            const dateB = b.date || '';
            if (dateA !== dateB) return dateB.localeCompare(dateA);
            return b.path.localeCompare(a.path);
        });
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
    if (track.bike) {
        const bikeEl = document.createElement('div');
        bikeEl.className = 'track-bike';
        bikeEl.innerText = `🏍️ ${track.bike}`;
        item.appendChild(bikeEl);
    }
    item.appendChild(descEl);

    item.onclick = () => {
        if (track.layer) {
            const bounds = track.layer.getBounds && track.layer.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds);
            }
            setActiveTrack(track.path);
        }
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

function initTrackLayer(track, index) {
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
        track.layer = layer;

        layer.on('mouseover', function() {
            const isActive = activeTrackPath === track.path;
            this.setStyle({
                color: '#ff5a36',
                weight: isActive ? 7 : 6,
                opacity: 1
            });
            this.bindTooltip(tooltipText, {
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
            setActiveTrack(track.path);
        });

        if (index === 0) {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds);
            }
            setActiveTrack(track.path);
        }
    });

    gpxLayer.on('error', function(err) {
        console.error('GPX load error:', track.path, err);
    });

    gpxLayer.addTo(map);
}

async function init() {
    try {
        allTracks = await fetchTrackManifest();

        if (allTracks.length === 0) {
            statusEl.innerText = 'tracks.json에 GPX 항목이 없습니다.';
            return;
        }

        renderTrackList();
        allTracks.forEach((track, index) => initTrackLayer(track, index));
        statusEl.innerText = `총 ${allTracks.length}개의 투어 로드 완료`;
    } catch (e) {
        console.error(e);
        statusEl.innerText = 'tracks.json 또는 GPX 파일을 불러오지 못했습니다.';
    }
}

searchInput.addEventListener('input', renderTrackList);

init();
