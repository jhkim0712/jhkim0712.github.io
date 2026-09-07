#!/usr/bin/env node
/**
 * tracks.json에 등록된 각 GPX 파일에서 경량 미리보기(overview) 좌표를 뽑아
 * assets/data/track-overview.json 으로 저장하는 빌드 스크립트.
 *
 * 목적:
 *   - GPX 원본은 트랙포인트가 수천~수만 개라 첫 페이지 로드 시 전부 내려받아
 *     파싱하면 GPX 데이터가 늘어날수록 로드 시간이 계속 길어짐.
 *   - 여기서 미리 Douglas-Peucker 알고리즘으로 좌표를 단순화해두면,
 *     첫 화면은 이 가벼운 JSON 하나만 읽어 즉시 모든 경로 개요를 그릴 수 있고,
 *     원본 GPX(정밀 경로)는 사용자가 클릭했을 때만(혹은 유휴 시간에 순차적으로)
 *     불러오면 됨.
 *   - config.json의 homeObfuscation(홈 위치 반경) 안에 들어오는 좌표는 여기서
 *     아예 제거해버린다 - 이 출력 파일(assets/data/track-overview.json)은 정적
 *     경로로 누구나 직접 열어볼 수 있으므로, 지도에서만 숨기는 걸로는 부족하고
 *     데이터 자체에서 빼야 함. 원본 GPX(raw.githubusercontent.com으로 직접 fetch됨)는
 *     이 스크립트가 손대는 대상이 아니라 여전히 전체 좌표를 담고 있으니, 정밀 경로
 *     쪽 마스킹은 assets/js/main.js의 maskHomeAreaOnLayer가 런타임에 담당한다.
 *
 * 사용법:
 *   node scripts/build-track-overview.js
 *
 * tracks.json 이나 tracks/**.gpx 를 추가/수정한 뒤에는 반드시 다시 실행해서
 * assets/data/track-overview.json 을 갱신해야 함 (README 참고).
 * .github/workflows/build-track-overview.yml 이 push 시 자동으로도 실행해줌.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'tracks.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const OUTPUT_PATH = path.join(ROOT, 'assets', 'data', 'track-overview.json');

// 트랙 하나당(구간별) 이 정도 포인트 수로 수렴시킴 (지도 개요용이므로 이 정도면 충분히 매끄러움)
const TARGET_MAX_POINTS = 220;
// 단순화 시작 허용 오차(미터). 값이 클수록 포인트가 더 줄어듬.
const INITIAL_EPSILON_M = 8;

// config.json의 homeObfuscation.center 는 XOR + Base64로 인코딩되어 있다.
// assets/js/main.js의 _d 함수와 동일한 방식(키 0xA5)으로 복원한다.
function decodeHomeCenter(encoded, key) {
    const raw = Buffer.from(encoded, 'base64');
    const buf = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
        buf[i] = raw[i] ^ key;
    }
    return [buf.readDoubleBE(0), buf.readDoubleBE(8)];
}

function readHomeObfuscation() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (!raw.homeObfuscation || !raw.homeObfuscation.center) return null;
        return {
            center: decodeHomeCenter(raw.homeObfuscation.center, 0xA5),
            radiusKm: raw.homeObfuscation.radiusKm || 0
        };
    } catch (e) {
        console.warn('config.json의 홈 위치 정보를 읽지 못해 반경 마스킹 없이 진행합니다.', e.message);
        return null;
    }
}

function readManifest() {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
        throw new Error('tracks.json 형식이 올바르지 않습니다 (배열이 아님).');
    }
    return items.filter(item => item.path && item.path.toLowerCase().endsWith('.gpx'));
}

// GPX는 단순 XML이라 <trkpt lat="" lon=""> 만 뽑아내면 충분함 (정규식이 정식 XML
// 파서보다 대용량 파일에서 훨씬 빠르고, 여기서는 좌표만 필요함).
function extractTrackPoints(gpxText) {
    const points = [];
    const re = /<trkpt\s+[^>]*lat="(-?\d+(?:\.\d+)?)"[^>]*lon="(-?\d+(?:\.\d+)?)"/g;
    let match;
    while ((match = re.exec(gpxText)) !== null) {
        points.push([parseFloat(match[1]), parseFloat(match[2])]);
    }
    return points;
}

// 위경도 차이를 대략적인 미터 단위 평면 좌표로 변환 (단순화 허용오차 계산용으로 충분한 근사치)
function toMeters(lat, lon, refLat) {
    const R = 111320; // 위도 1도 ≈ 111.32km
    const x = lon * R * Math.cos(refLat * Math.PI / 180);
    const y = lat * R;
    return [x, y];
}

function perpendicularDistanceMeters(point, start, end, refLat) {
    const [px, py] = toMeters(point[0], point[1], refLat);
    const [sx, sy] = toMeters(start[0], start[1], refLat);
    const [ex, ey] = toMeters(end[0], end[1], refLat);

    const dx = ex - sx;
    const dy = ey - sy;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return Math.hypot(px - sx, py - sy);
    }

    const t = ((px - sx) * dx + (py - sy) * dy) / lenSq;
    const clampedT = Math.max(0, Math.min(1, t));
    const projX = sx + clampedT * dx;
    const projY = sy + clampedT * dy;
    return Math.hypot(px - projX, py - projY);
}

// Ramer-Douglas-Peucker 단순화 (재귀 대신 스택 기반으로 구현해 대용량 트랙에서도 안전)
function simplify(points, epsilonMeters) {
    if (points.length <= 2) return points.slice();

    const refLat = points[Math.floor(points.length / 2)][0];
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [startIdx, endIdx] = stack.pop();
        if (endIdx - startIdx < 2) continue;

        let maxDist = -1;
        let maxIdx = -1;
        for (let i = startIdx + 1; i < endIdx; i++) {
            const dist = perpendicularDistanceMeters(points[i], points[startIdx], points[endIdx], refLat);
            if (dist > maxDist) {
                maxDist = dist;
                maxIdx = i;
            }
        }

        if (maxDist > epsilonMeters) {
            keep[maxIdx] = 1;
            stack.push([startIdx, maxIdx]);
            stack.push([maxIdx, endIdx]);
        }
    }

    const result = [];
    for (let i = 0; i < points.length; i++) {
        if (keep[i]) result.push(points[i]);
    }
    return result;
}

function simplifyToTarget(points, targetMax, initialEpsilon) {
    if (points.length <= targetMax) return points;

    let epsilon = initialEpsilon;
    let simplified = simplify(points, epsilon);
    let iterations = 0;

    while (simplified.length > targetMax && iterations < 8) {
        epsilon *= 1.6;
        simplified = simplify(points, epsilon);
        iterations++;
    }

    return simplified;
}

// 두 좌표 사이의 실제 지표면 거리(km) - 하버사인 공식
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // 지구 평균 반지름(km)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 홈 위치 반경 안에 들어오는 좌표를 제거하고, 끊어진 자리마다 구간을 나눠서
// 돌려준다(구간 사이는 이어 그리지 않음). home이 없으면 전체를 한 구간으로 반환.
function splitAwayFromHome(points, home) {
    if (!home || !home.radiusKm) return [points];

    const segments = [];
    let current = [];
    for (const point of points) {
        const distKm = haversineKm(point[0], point[1], home.center[0], home.center[1]);
        if (distKm <= home.radiusKm) {
            if (current.length > 1) segments.push(current);
            current = [];
        } else {
            current.push(point);
        }
    }
    if (current.length > 1) segments.push(current);
    return segments;
}

// 트랙 전체(단순화 전) 포인트를 순서대로 이어 총 이동거리(km) 계산
function computeTotalDistanceKm(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    }
    return total;
}

function computeBounds(points) {
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const [lat, lon] of points) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    }
    return [[minLat, minLon], [maxLat, maxLon]];
}

function roundCoord(n) {
    // 소수점 6자리(약 11cm 정밀도)면 미리보기 용도로 충분 + JSON 용량 절약
    return Math.round(n * 1e6) / 1e6;
}

function main() {
    const entries = readManifest();
    const home = readHomeObfuscation();
    const overview = {};
    let missing = 0;
    let totalOriginal = 0;
    let totalSimplified = 0;

    if (home) {
        console.log(`홈 위치 반경 ${home.radiusKm}km 이내 좌표는 미리보기 데이터에서 제외합니다.`);
    }

    for (const entry of entries) {
        const gpxPath = path.join(ROOT, entry.path);
        if (!fs.existsSync(gpxPath)) {
            console.warn(`[skip] GPX 파일을 찾을 수 없음: ${entry.path}`);
            missing++;
            continue;
        }

        const gpxText = fs.readFileSync(gpxPath, 'utf8');
        const points = extractTrackPoints(gpxText);

        if (points.length === 0) {
            console.warn(`[skip] 트랙포인트가 없음: ${entry.path}`);
            continue;
        }

        // 홈 반경 내 좌표를 먼저 제거해 구간으로 나눈 뒤, 구간별로 단순화한다
        // (구간을 나누기 전에 단순화하면 홈을 지나는 직선이 남아 위치가 그대로 드러남)
        const segments = splitAwayFromHome(points, home)
            .map(seg => simplifyToTarget(seg, TARGET_MAX_POINTS, INITIAL_EPSILON_M))
            .filter(seg => seg.length >= 2);

        if (segments.length === 0) {
            console.warn(`[skip] 홈 반경 마스킹 후 남은 좌표가 없음: ${entry.path}`);
            continue;
        }

        const bounds = computeBounds(points);
        // 마스킹/단순화 전 전체 포인트 기준으로 계산해야 실제 이동거리에 가까움
        // (단순화된 좌표로 계산하면 코너를 잘라서 짧게 나옴)
        const distanceKm = Math.round(computeTotalDistanceKm(points) * 10) / 10;
        const simplifiedCount = segments.reduce((sum, seg) => sum + seg.length, 0);

        overview[entry.path] = {
            points: segments.map(seg => seg.map(([lat, lon]) => [roundCoord(lat), roundCoord(lon)])),
            bounds,
            originalCount: points.length,
            distanceKm
        };

        totalOriginal += points.length;
        totalSimplified += simplifiedCount;

        const segmentNote = segments.length > 1 ? ` (${segments.length}개 구간으로 분리)` : '';
        console.log(`${entry.path}: ${points.length} -> ${simplifiedCount} points${segmentNote}, ${distanceKm}km`);
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(overview));

    const outSize = fs.statSync(OUTPUT_PATH).size;
    console.log('---');
    console.log(`총 ${Object.keys(overview).length}개 트랙 처리 (누락 ${missing}개)`);
    console.log(`포인트: ${totalOriginal} -> ${totalSimplified} (${(100 * totalSimplified / totalOriginal).toFixed(1)}%)`);
    console.log(`출력 파일: ${path.relative(ROOT, OUTPUT_PATH)} (${(outSize / 1024).toFixed(1)} KB)`);
}

main();
