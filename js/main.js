const CONFIG = {
    owner: 'jhkim0712',
    repo: 'jhkim0712.github.io',
    branch: 'main',
    manifestPath: 'tracks.json'
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

function buildRawFileUrl(path) {
    return `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${path}`;
}

function getDisplayTitle(track) {
    return track.title || track.name || track.path.split('/').pop();
}

function getMetaText(track) {
    const meta = [];
    if (track.date) meta.push(track.date);
    if (track.region) meta.push(track.region);
    return meta.join(' · ');
}

function getTooltipText(track) {
    const title = getDisplayTitle(track);
    return track.description ? `${title} - ${track.description}` : title;
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
        track.name,
        track.title,
        track.description,
        track.date,
        track.region
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
            name: item.name || '',
            title: item.title || '',
            description: item.description || '',
            date: item.date || '',
            region: item.region || '',
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
    item.appendChild(descEl);

    item.onclick = () => {
        if (track.layer) {
            const bounds = track.layer.getBounds && track.layer.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
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
            if (bounds && bounds.isValid && bounds.isValid()) {
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
