let pairs = {};
let lines = [];
let activeVfdPath = null;
let pendingAnnouncement = null;
let adAudioMuted = false;
// Hidden displays keep playing silently so clip sequencing stays intact when the mode changes.
const displayModes = [
    { id: "all", label: "All displays", caption: "Display<br>All", screens: true, vfd: true },
    { id: "screens", label: "Screens only", caption: "Display<br>Screens", screens: true, vfd: false },
    { id: "vfd", label: "VFD only", caption: "Display<br>VFD", screens: false, vfd: true }
];
const displayModeStorageKey = "nsl-transit-display-mode";
let displayModeIndex = 0;
try {
    displayModeIndex = Math.max(0, displayModes.findIndex((mode) => mode.id === localStorage.getItem(displayModeStorageKey)));
} catch { }
function applyDisplayMode() {
    const mode = displayModes[displayModeIndex];
    ["cddScreen", "cldScreen"].forEach((id) => $(id)?.classList.toggle("mode-off", !mode.screens));
    $("vfdPanel")?.classList.toggle("mode-off", !mode.vfd);
    ["screen-l", "screen-r"].forEach((id) => {
        const video = $(id);
        if (!video) return;
        if (!mode.screens) video.muted = true;
        else video.muted = id === "screen-r" && isAdAudioPath(video.currentSrc || video.src) && adAudioMuted;
    });
    const vfd = $("vfdVideo");
    if (vfd) vfd.muted = !mode.vfd;
    const button = $("displayModeButton");
    if (!button) return;
    button.setAttribute("aria-label", `Display mode: ${mode.label}`);
    button.title = `Display mode: ${mode.label}`;
    $("displayModeCaption").innerHTML = mode.caption;
}
const videoBlobCache = new Map();
function videoUrl(path) {
    const url = new URL(path, document.baseURI).href;
    return videoBlobCache.get(url) || url;
}
function collectVideoPaths(node, found = new Set()) {
    if (typeof node === "string") {
        if (/\.mp4$/i.test(node)) found.add(new URL(node, document.baseURI).href);
    } else if (node && typeof node === "object") {
        Object.values(node).forEach((value) => collectVideoPaths(value, found));
    }
    return found;
}
// Loads every clip and stores it in Cache Storage so later visits load from disk instead of the network.
const videoCacheName = "staris-videos-v1";
let videosReady = false;
let videosLoaded = 0;
let videosTotal = 0;
let pendingPlay = null;
const videoLoadingText = () => `Loading videos ${videosLoaded}/${videosTotal}`;
function reportVideoProgress() {
    if (videosReady) return;
    const route = $("lcdRoute");
    if (route) route.textContent = videoLoadingText();
}
async function preloadVideos(data) {
    const ordered = new Set();
    data.lines.forEach((line) => line.presets.forEach((preset) => preset.stations.forEach((name) => collectVideoPaths(data.pairs[name], ordered))));
    collectVideoPaths(data, ordered);
    const queue = [...ordered];
    videosTotal = queue.length;
    reportVideoProgress();
    const cache = "caches" in window ? await caches.open(videoCacheName).catch(() => null) : null;
    // Revalidates a saved clip against the server so replaced videos are re-downloaded; offline keeps the saved copy.
    const isCachedCurrent = async (url, cached) => {
        try {
            const head = await fetch(url, { method: "HEAD", cache: "no-cache" });
            if (!head.ok) return true;
            const pairs = [["etag"], ["last-modified"], ["content-length"]];
            return pairs.every(([h]) => {
                const fresh = head.headers.get(h);
                const old = cached.headers.get(h);
                return !fresh || !old || fresh === old;
            });
        } catch {
            return true;
        }
    };
    // Retries network errors until the clip arrives; missing files (4xx) are skipped so they cannot block playback.
    // Retries until the clip arrives so playback is only unlocked once every video is loaded.
    const fetchWithRetry = async (url) => {
        for (let attempt = 0; ; attempt++) {
            if (navigator.onLine !== false) {
                try {
                    const response = await fetch(url, { cache: "no-cache" });
                    if (response.ok) return response;
                    if (response.status >= 400 && response.status < 500) return null;
                } catch { }
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
        }
    };
    const worker = async () => {
        while (queue.length) {
            const url = queue.shift();
            for (;;) {
                try {
                    let response = cache && await cache.match(url);
                    if (response && !(await isCachedCurrent(url, response))) {
                        await cache.delete(url);
                        response = null;
                    }
                    if (!response) {
                        response = await fetchWithRetry(url);
                        if (!response) {
                            console.warn("Video not found, skipping:", url);
                            break;
                        }
                        if (cache) await cache.put(url, response.clone()).catch(() => { });
                    }
                    videoBlobCache.set(url, URL.createObjectURL(await response.blob()));
                    break;
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
            videosLoaded += 1;
            reportVideoProgress();
        }
    };
    await (document.readyState === "complete" ? Promise.resolve() : new Promise((resolve) => window.addEventListener("load", resolve, { once: true })));
    await Promise.all(Array.from({ length: 3 }, worker));
    videosReady = true;
    if (pendingPlay) {
        const [clip, message, options] = pendingPlay;
        pendingPlay = null;
        playClip(clip, message, options);
    } else {
        render();
    }
}
fetch("js/transit-data.json")
    .then((response) => response.json())
    .then((data) => {
        preloadVideos(data);
        pairs = data.pairs;
        lines = data.lines.map((line) => ({
            ...line,
            presets: line.presets.map((preset) => ({
                ...preset,
                stations: preset.stations.map((name) => pairs[name])
            }))
        }));
        const navigationEntry = performance.getEntriesByType("navigation")[0];
        const isRefresh = navigationEntry ? navigationEntry.type === "reload" : performance.navigation?.type === 1;
        if (isRefresh && restoreLastStation()) {
            const lastStation = currentClip();
            playClip(lastStation, `Restored station · ${lastStation.station}`);
        } else {
            if (!isRefresh) {
                try {
                    localStorage.removeItem(lastStationStorageKey);
                } catch { }
            }
            render();
        }
    })
    .catch(() => {
        console.error("Failed to load transit configuration.");
        render("Configuration error · check transit-data.json");
    });
let lineIndex = 0;
let stopIndex = -1;
let selectedScenario = 0;
let selectedPreset = 0;
let isRunning = false;
let isReverse = false;
let isMaintenance = false;
let activeClip = null;
let playbackGeneration = 0;
let hasPressedStationForward = false;
const lastStationStorageKey = "nsl-transit-last-station";
const $ = (id) => document.getElementById(id);
function isAdAudioPath(path) {
    return /(?:^|\/)ad-(?:arr|nxt)\.mp4(?:$|[?#])/i.test(path || "");
}
function updateAdAudioButton(path) {
    const button = $("adAudioToggle");
    if (!button) return;
    const isAd = isAdAudioPath(path);
    $("cldScreen").classList.toggle("has-ad-audio", isAd);
    button.disabled = !isAd;
    button.setAttribute("aria-label", adAudioMuted ? "Unmute advertisement audio" : "Mute advertisement audio");
    button.title = adAudioMuted ? "Unmute advertisement audio" : "Mute advertisement audio";
    button.setAttribute("aria-pressed", String(adAudioMuted));
}
// Lever A only enables preset 1 of the line rows; lever B only enables preset 2. Message rows are unaffected.
// Line B (EWL) additionally allows preset 3 on lever B.
const leverPreset = () => (isReverse ? 1 : 0);
const allowedPresets = (code) => (code === "EWL" && isReverse ? [1, 2] : [leverPreset()]);
const defaultPreset = () => {
    const line = currentLine();
    if (line?.code === "MSG") return 0;
    return allowedPresets(line?.code).find((index) => line?.presets[index]) ?? 0;
};
const currentLine = () => lines[lineIndex];
// Line-specific doors closing clip; falls back to the default one until that line's videos are available.
function doorsClosingPair() {
    const lineSpecific = currentLine()?.code === "EWL" ? pairs.ewlDoorsClosingPair : null;
    const isLoaded = lineSpecific && videoBlobCache.has(new URL(lineSpecific["screen-l"], document.baseURI).href);
    return isLoaded ? lineSpecific : pairs.doorsClosingPair;
}
const isDoorsClosingPair = (clip) => clip === pairs.doorsClosingPair || clip === pairs.ewlDoorsClosingPair;
const currentPreset = () => currentLine().presets[selectedPreset];
const currentStations = () => currentPreset().stations;
const currentClip = () => currentStations()[Math.max(0, stopIndex) % currentStations().length];
const currentStop = () => currentClip().station;
function rememberLastStation(clip) {
    if (!currentStations().includes(clip)) return;
    try {
        localStorage.setItem(lastStationStorageKey, JSON.stringify({
            lineName: currentLine().name,
            presetName: currentPreset().name,
            station: clip.station,
            "screen-l": clip["screen-l"]
        }));
    } catch { }
}
function restoreLastStation() {
    try {
        const saved = JSON.parse(localStorage.getItem(lastStationStorageKey));
        if (!saved) return false;
        const restoredLineIndex = lines.findIndex((line) => line.name === saved.lineName);
        const presets = lines[restoredLineIndex]?.presets;
        const restoredPresetIndex = presets?.findIndex((preset) =>
            (!saved.presetName || preset.name === saved.presetName) &&
            preset.stations.some((clip) => clip.station === saved.station && clip["screen-l"] === saved["screen-l"])
        ) ?? -1;
        const stations = presets?.[restoredPresetIndex]?.stations;
        const restoredStopIndex = stations?.findIndex((clip) => clip.station === saved.station && clip["screen-l"] === saved["screen-l"]) ?? -1;
        if (restoredLineIndex < 0 || restoredPresetIndex < 0 || restoredStopIndex < 0) return false;
        lineIndex = restoredLineIndex;
        stopIndex = restoredStopIndex;
        selectedScenario = lineIndex;
        selectedPreset = restoredPresetIndex;
        hasPressedStationForward = true;
        return true;
    } catch {
        return false;
    }
}
function updateLcdDistance() {
    const isStationClip = activeClip && activeClip !== pairs.maintenancePair && !isDoorsClosingPair(activeClip) &&
        !(currentLine()?.code === "MSG" && currentStations().includes(activeClip));
    if (ride && activeClip === ride.clip) {
        $("lcdDistance").textContent = `Distance: ${Math.ceil(ride.remaining)} m`;
        return;
    }
    $("lcdDistance").textContent = isStationClip && activeClip.displayState !== "arrived" ? `Destination: ${activeClip.destination}` : "";
}
// Ride simulation: counts down the metres to the next station, then plays the arrival and arrived pairs.
let rideMode = false;
let rideDistances = null;
let ride = null;
let rideDoneClip = null;
let rideLastTick = 0;
function segmentMetres(clip) {
    return rideDistances?.routes?.[currentLine()?.code]?.[currentPreset()?.name]?.find((segment) => segment.to === clip.station)?.metres ?? null;
}
function playArrival() {
    if (!hasPressedStationForward) return;
    const stationClip = currentClip();
    const arrival = stationClip.arrival;
    if (!arrival?.approaching) return;
    playClip(pairs[arrival.approaching], `Arriving · ${stationClip.station}`, {
        cddLoop: false,
        cldLoop: true,
        ...(arrival.arrived ? { nextPair: pairs[arrival.arrived] } : {})
    });
}
function tickRide() {
    const now = performance.now();
    const elapsed = (now - rideLastTick) / 1000;
    rideLastTick = now;
    if (!rideMode || !videosReady || isMaintenance || !hasPressedStationForward || !lines.length) {
        ride = null;
        return;
    }
    const stationClip = currentClip();
    if (ride && ride.clip !== stationClip) ride = null;
    if (activeClip !== rideDoneClip) rideDoneClip = null;
    if (!ride) {
        const metres = activeClip === stationClip && isRunning && stationClip.arrival?.approaching && stationClip !== rideDoneClip ? segmentMetres(stationClip) : null;
        if (metres === null) return;
        ride = { clip: stationClip, remaining: metres };
        updateLcdDistance();
        return;
    }
    const speed = rideDistances?.simulatedSpeedMetresPerSecond || 20;
    ride.remaining = Math.max(0, ride.remaining - speed * elapsed);
    updateLcdDistance();
    if (ride.remaining > 0) return;
    rideDoneClip = ride.clip;
    ride = null;
    playArrival();
}
setInterval(tickRide, 200);
fetch("js/station-distances.json")
    .then((response) => response.json())
    .then((data) => { rideDistances = data; })
    .catch(() => console.error("Failed to load station distances."));
function render(message) {
    // $("routeLine").textContent = currentLine().code;
    // $("routeCode").textContent = `${isReverse ? "S/N" : "N/S"}: 2012A`;
    const vfd = $("vfdVideo");
    if (vfd && activeVfdPath) {
        const vfdSource = videoUrl(activeVfdPath);
        if (vfd.src !== vfdSource) {
            vfd.src = vfdSource;
        }
    }
    if (vfd && !activeClip) {
        vfd.pause();
        if (vfd.readyState > 0) vfd.currentTime = 0;
    }
    const isMaintenanceClip = activeClip === pairs.maintenancePair;
    const isMessageClip = currentLine()?.code === "MSG" && currentStations().includes(activeClip);
    const isDoorsClosingClip = isDoorsClosingPair(activeClip);
    $("lcdRoute").textContent = !videosReady && videosTotal ? videoLoadingText() : isMaintenanceClip ? "Maintenance Mode" : isDoorsClosingClip ? "→ Doors Closing" : isMessageClip ? `→ MSG · ${activeClip.station}` : activeClip ? `→ ${currentLine().code} · ${currentPreset().name}` : "Ready...";
    const isArrivedClip = activeClip?.displayState === "arrived";
    const isArrival = activeClip?.displayState === "approaching" || isArrivedClip;
    $("lcdStation").textContent = activeClip && !isMaintenanceClip && !isMessageClip && !isDoorsClosingClip ? `${isArrivedClip ? "Arrived:" : isArrival ? "Approaching:" : "Next:"} ${activeClip.station}` : "";
    updateLcdDistance();
    $("messageStrip").textContent = message || `${isMaintenance ? "Maintenance mode" : "System ready"} · ${isReverse ? "Southbound" : "Northbound"} · ${isRunning ? "announcement active" : "doors secured"}`;
    $("modeReadout").textContent = `${isMaintenance ? "MAINTENANCE" : "NORMAL SERVICE"} · ${isRunning ? "RUN" : "AUTO"}`;
    $("inUseLight").classList.toggle("on", isRunning);
    $("activeLight").classList.toggle("on", isRunning);
    $("dcLight").classList.toggle("blue", isRunning && isDoorsClosingClip);
    $("linkLight").classList.toggle("green", !isRunning);
    $("doorsClosingButton").classList.toggle("active", isRunning && isDoorsClosingClip);
    $("doorsClosingButton").setAttribute("aria-pressed", String(isRunning && isDoorsClosingClip));
    $("arrivedButton").setAttribute("aria-pressed", String(isRunning && isArrival));
    $("arrivedButton").disabled = !hasPressedStationForward;
    $("arrivedButton").title = hasPressedStationForward ? "Play arrival sequence" : "Select a station first";
    $("directionLever").classList.toggle("reverse", isReverse);
    $("directionLever").setAttribute("aria-pressed", String(isReverse));
    document.querySelectorAll(".scenario-button").forEach((button) => {
        const scenario = Number(button.dataset.scenario);
        const preset = Number(button.dataset.preset);
        const isConfigured = Boolean(lines[scenario]?.presets[preset]);
        const selected = scenario === selectedScenario && preset === selectedPreset;
        const blockedByLever = lines[scenario]?.code !== "MSG" && !allowedPresets(lines[scenario]?.code).includes(preset);
        button.disabled = !isConfigured || blockedByLever;
        button.setAttribute("aria-pressed", String(selected));
    });
}
function stopPlayback(message = "Playback stopped · ready", clearClip = false) {
    playbackGeneration += 1;
    pendingAnnouncement = null;
    isRunning = false;
    [$("screen-l"), $("screen-r"), $("vfdVideo")].forEach((video) => {
        if (!video) return;
        video.pause();
        if (video.readyState > 0) video.currentTime = 0;
        video.removeAttribute("src");
        video.load();
    });
    activeVfdPath = null;
    updateAdAudioButton(null);
    const audio = $("announcementAudio");
    audio.pause();
    if (audio.readyState > 0) audio.currentTime = 0;
    if (clearClip) activeClip = null;
    $("cddScreen").classList.remove("is-playing");
    $("cldScreen").classList.remove("is-playing");
    $("vfdPanel").classList.remove("is-playing");
    render(message);
}
function loadVideo(video, screen, path, loop, generation) {
    if (!path) return;
    const source = videoUrl(path);
    video.loop = loop;
    const isAdAudio = video.id === "screen-r" && isAdAudioPath(path);
    const mode = displayModes[displayModeIndex];
    const hiddenByMode = video.id === "vfdVideo" ? !mode.vfd : !mode.screens;
    video.muted = hiddenByMode || (isAdAudio && adAudioMuted);
    if (video.id === "screen-r") updateAdAudioButton(path);
    if (video.src !== source) {
        video.src = source;
    } else {
        video.currentTime = 0;
    }
    screen.classList.add("is-playing");
    video.play().catch((error) => {
        if (error.name === "AbortError" || generation !== playbackGeneration) return;
        if (error.name === "NotAllowedError" && !video.muted) {
            video.muted = true;
            video.play().catch((fallbackError) => {
                if (fallbackError.name === "AbortError" || generation !== playbackGeneration) return;
                isRunning = false;
                render("Video unavailable · check local asset");
            });
            return;
        }
        isRunning = false;
        render("Video unavailable · check local asset");
    });
}
function playClip(clip, message, options = {}) {
    if (!videosReady) {
        pendingPlay = [clip, message, options];
        render();
        return;
    }
    stopPlayback("Loading video pair");
    const generation = playbackGeneration;
    activeClip = clip;
    activeVfdPath = clip.vfd || null;
    isRunning = true;
    rememberLastStation(clip);
    const screenL = $("screen-l");
    const screenR = $("screen-r");
    const vfdVideo = $("vfdVideo");
    const isMessageClip = currentLine()?.code === "MSG" && currentStations().includes(clip);
    if (options.nextPair) {
        let endedVideos = 0;
        let announcementFinished = false;
        const triggerNextPair = () => {
            if (generation !== playbackGeneration) return;
            playClip(options.nextPair, `Arrived · ${options.nextPair.station}`);
        };
        const isArrivalLoop = clip.displayState === "approaching";
        if (clip.announcement) {
            const audio = $("announcementAudio");
            audio.addEventListener("ended", () => {
                if (generation !== playbackGeneration) return;
                announcementFinished = true;
                if (isArrivalLoop) {
                    triggerNextPair();
                    return;
                }
                if (endedVideos === 2) triggerNextPair();
            }, { once: true });
        }
        [screenL, screenR].forEach((video) => video.addEventListener("ended", () => {
            if (generation !== playbackGeneration) return;
            endedVideos += 1;
            if (isArrivalLoop) return;
            if (endedVideos === 2 && (!clip.announcement || announcementFinished)) triggerNextPair();
        }, { once: true }));
    }
    if (options.stopOnComplete) {
        let endedVideos = 0;
        [screenL, screenR].forEach((video) => video.addEventListener("ended", () => {
            if (generation !== playbackGeneration) return;
            endedVideos += 1;
            if (endedVideos === 2) {
                isRunning = false;
                render("Doors closing sequence complete");
            }
        }, { once: true }));
    }
    const isArrivingClip = clip.displayState === "approaching";
    const hasNextRightScreen = Boolean(clip["screen-r2"]);
    const shouldLoopArrivalScreen = !isMessageClip && isArrivingClip && !!clip.announcement;
    const shouldLoopScreenL = isMessageClip ? false : shouldLoopArrivalScreen || (options.cddLoop ?? true);
    const shouldLoopScreenR = isMessageClip ? false : shouldLoopArrivalScreen || (hasNextRightScreen ? false : (options.cldLoop ?? true));
    if (clip.announcement) {
        const audio = $("announcementAudio");
        audio.src = new URL(clip.announcement, document.baseURI).href;
        audio.play().then(() => {
            if (generation === playbackGeneration) pendingAnnouncement = null;
        }).catch((error) => {
            if (error.name === "NotAllowedError" && generation === playbackGeneration) {
                pendingAnnouncement = { generation, source: audio.src };
                $("messageStrip").textContent = "Announcement blocked · click to play";
            }
        });
    }
    loadVideo(screenL, $("cddScreen"), clip["screen-l"], shouldLoopScreenL, generation);
    loadVideo(screenR, $("cldScreen"), clip["screen-r"], shouldLoopScreenR, generation);
    if (hasNextRightScreen) {
        screenR.addEventListener("ended", () => {
            if (generation !== playbackGeneration) return;
            loadVideo(screenR, $("cldScreen"), clip["screen-r2"], !isMessageClip, generation);
        }, { once: true });
    }
    if (vfdVideo && clip.vfd) {
        const isDoorsClosing = isDoorsClosingPair(clip);
        const nextVfdPath = clip["vfd-next"];
        if (nextVfdPath) {
            vfdVideo.addEventListener("ended", () => {
                if (generation !== playbackGeneration) return;
                activeVfdPath = nextVfdPath;
                loadVideo(vfdVideo, $("vfdPanel"), nextVfdPath, true, generation);
            }, { once: true });
        }
        loadVideo(vfdVideo, $("vfdPanel"), clip.vfd, Boolean(nextVfdPath) || isDoorsClosing || isMessageClip ? false : true, generation);
    }
    render(message || `Playing ${clip.station} · to ${clip.destination}`);
}
function moveStation(step) {
    const stations = currentStations();
    if (!stations.length) return;
    const baseIndex = stopIndex < 0 ? (step > 0 ? -1 : 0) : stopIndex;
    if (step > 0 && baseIndex >= stations.length - 1) return;
    if (step < 0 && baseIndex <= 0) return;
    stopIndex = baseIndex + step;
    const clip = currentClip();
    const direction = step > 0 ? "forward" : "backward";
    const statusMessage = currentLine().code === "MSG"
        ? `Message selected · ${clip.station}`
        : `Station ${direction} · ${clip.station} to ${clip.destination}`;
    playClip(clip, statusMessage);
}
$("stationUp").addEventListener("click", () => {
    hasPressedStationForward = true;
    const previousStopIndex = stopIndex;
    moveStation(1);
    if (stopIndex === previousStopIndex) render();
});
$("stationDown").addEventListener("click", () => moveStation(-1));
$("routePrevious").addEventListener("click", () => { lineIndex = (lineIndex + lines.length - 1) % lines.length; selectedScenario = lineIndex; selectedPreset = defaultPreset(); stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("routeNext").addEventListener("click", () => { lineIndex = (lineIndex + 1) % lines.length; selectedScenario = lineIndex; selectedPreset = defaultPreset(); stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("resetButton").addEventListener("click", () => { hasPressedStationForward = false; lineIndex = 0; stopIndex = -1; selectedScenario = 0; selectedPreset = 0; isReverse = false; isMaintenance = false; stopPlayback("Reset · videos stopped", true); });
$("modeButton").addEventListener("click", () => {
    isMaintenance = !isMaintenance;
    if (isMaintenance) {
        playClip(pairs.maintenancePair, "Maintenance mode · vfd & screen test");
    } else {
        stopPlayback("Normal service · announcements enabled", true);
    }
});
$("doorsClosingButton").addEventListener("click", () => playClip(doorsClosingPair(), "Doors closing", { cddLoop: true, cldLoop: true }));
$("arrivedButton").addEventListener("click", () => {
    ride = null;
    rideDoneClip = activeClip;
    playArrival();
});
$("rideButton").addEventListener("click", () => {
    rideMode = !rideMode;
    ride = null;
    rideDoneClip = null;
    const label = `Ride simulation: ${rideMode ? "on" : "off"}`;
    $("rideButton").setAttribute("aria-label", label);
    $("rideButton").setAttribute("aria-pressed", String(rideMode));
    $("rideButton").title = label;
    $("rideButton").classList.toggle("selected", rideMode);
    $("rideCaption").innerHTML = `Ride<br>${rideMode ? "On" : "Off"}`;
    render(label);
});
$("directionLever").addEventListener("click", () => {
    isReverse = !isReverse;
    if (currentLine()?.code === "MSG") {
        render(`Lever ${isReverse ? "B" : "A"}`);
        return;
    }
    const allowed = allowedPresets(currentLine()?.code);
    if (!allowed.some((index) => currentLine()?.presets[index])) {
        render(`Lever ${isReverse ? "B" : "A"} · select a preset ${allowed.map((index) => index + 1).join(" or ")}`);
        return;
    }
    selectedPreset = allowed.includes(selectedPreset) && currentLine().presets[selectedPreset] ? selectedPreset : defaultPreset();
    stopIndex = 0;
    hasPressedStationForward = Boolean(currentClip().arrival?.approaching);
    playClip(currentClip(), `Lever ${isReverse ? "B" : "A"} · ${currentLine().name} · ${currentPreset().name}`);
});
document.querySelectorAll(".scenario-button").forEach((button) => button.addEventListener("click", () => {
    selectedScenario = Number(button.dataset.scenario);
    lineIndex = selectedScenario;
    selectedPreset = Number(button.dataset.preset);
    stopIndex = 0;
    hasPressedStationForward = Boolean(currentClip().arrival?.approaching);
    const selectionDetail = currentLine().code === "MSG" ? ` · ${currentClip().station}` : "";
    playClip(currentClip(), `${currentLine().name} · ${currentPreset().name}${selectionDetail}`);
}));
$("downloadButton").addEventListener("click", () => {
    const report = [`TRANSIT INFORMATION SYSTEM`, `Line: ${currentLine().code} ${currentPreset().name}`, `Selection: ${currentLine().name} / Preset ${selectedPreset + 1}`, `Next station: ${currentStop()}`, `Direction: ${isReverse ? "Southbound" : "Northbound"}`, `Mode: ${isMaintenance ? "Maintenance" : "Normal service"}`, `Status: ${isRunning ? "Running" : "Standby"}`].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([report], { type: "text/plain" }));
    link.download = "transit-service-readout.txt";
    link.click();
    URL.revokeObjectURL(link.href);
    render("Service readout downloaded");
});
$("displayModeButton").addEventListener("click", () => {
    displayModeIndex = (displayModeIndex + 1) % displayModes.length;
    try {
        localStorage.setItem(displayModeStorageKey, displayModes[displayModeIndex].id);
    } catch { }
    applyDisplayMode();
});
applyDisplayMode();
$("adAudioToggle").addEventListener("click", (event) => {
    event.stopPropagation();
    adAudioMuted = !adAudioMuted;
    const video = $("screen-r");
    video.muted = adAudioMuted;
    updateAdAudioButton(video.currentSrc || video.src);
});
document.addEventListener("click", () => {
    const pending = pendingAnnouncement;
    if (!pending) return;
    const audio = $("announcementAudio");
    if (pending.generation !== playbackGeneration || audio.src !== pending.source) {
        pendingAnnouncement = null;
        return;
    }
    audio.play().then(() => {
        if (pendingAnnouncement === pending) {
            pendingAnnouncement = null;
            $("messageStrip").textContent = "Announcement playing";
        }
    }).catch(() => { });
});
