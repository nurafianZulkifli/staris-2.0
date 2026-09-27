let pairs = {};
let lines = [];
let activeVfdPath = null;
let pendingAnnouncement = null;
fetch("js/transit-data.json")
    .then((response) => response.json())
    .then((data) => {
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
const currentLine = () => lines[lineIndex];
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
function render(message) {
    // $("routeLine").textContent = currentLine().code;
    // $("routeCode").textContent = `${isReverse ? "S/N" : "N/S"}: 2012A`;
    const vfd = $("vfdVideo");
    if (vfd && activeVfdPath) {
        const vfdSource = new URL(activeVfdPath, document.baseURI).href;
        if (vfd.src !== vfdSource) {
            vfd.src = vfdSource;
            vfd.load();
        }
    }
    if (vfd && !activeClip) {
        vfd.pause();
        if (vfd.readyState > 0) vfd.currentTime = 0;
    }
    const isMaintenanceClip = activeClip === pairs.maintenancePair;
    const isMessageClip = currentLine()?.code === "MSG" && currentStations().includes(activeClip);
    const isDoorsClosingClip = activeClip === pairs.doorsClosingPair;
    $("lcdRoute").textContent = isMaintenanceClip ? "Maintenance Mode" : isDoorsClosingClip ? "→ Doors Closing" : isMessageClip ? `→ MSG · ${activeClip.station}` : activeClip ? `→ ${currentLine().code} · ${currentPreset().name}` : "Ready...";
    const isArrivedClip = activeClip?.displayState === "arrived";
    const isArrival = activeClip?.displayState === "approaching" || isArrivedClip;
    $("lcdStation").textContent = activeClip && !isMaintenanceClip && !isMessageClip && !isDoorsClosingClip ? `${isArrivedClip ? "Arrived:" : isArrival ? "Approaching:" : "Next:"} ${activeClip.station}` : "";
    $("lcdDistance").textContent = activeClip && !isMaintenanceClip && !isMessageClip && !isDoorsClosingClip && !isArrivedClip ? `Destination: ${activeClip.destination}` : "";
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
        button.disabled = !isConfigured;
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
    const source = new URL(path, document.baseURI).href;
    video.loop = loop;
    video.muted = false;
    if (video.src !== source) {
        video.src = source;
        video.load();
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
        audio.load();
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
        const isDoorsClosing = clip === pairs.doorsClosingPair;
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
$("routePrevious").addEventListener("click", () => { lineIndex = (lineIndex + lines.length - 1) % lines.length; selectedScenario = lineIndex; selectedPreset = 0; stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("routeNext").addEventListener("click", () => { lineIndex = (lineIndex + 1) % lines.length; selectedScenario = lineIndex; selectedPreset = 0; stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("resetButton").addEventListener("click", () => { hasPressedStationForward = false; lineIndex = 0; stopIndex = -1; selectedScenario = 0; selectedPreset = 0; isReverse = false; isMaintenance = false; stopPlayback("Reset · videos stopped", true); });
$("modeButton").addEventListener("click", () => {
    isMaintenance = !isMaintenance;
    if (isMaintenance) {
        playClip(pairs.maintenancePair, "Maintenance mode · vfd & screen test");
    } else {
        stopPlayback("Normal service · announcements enabled", true);
    }
});
$("doorsClosingButton").addEventListener("click", () => playClip(pairs.doorsClosingPair, "Doors closing", { cddLoop: false, cldLoop: false, stopOnComplete: true }));
$("arrivedButton").addEventListener("click", () => {
    if (!hasPressedStationForward) return;
    const stationClip = currentClip();
    const arrival = stationClip.arrival;
    if (!arrival?.approaching) return;
    playClip(pairs[arrival.approaching], `Arriving · ${stationClip.station}`, {
        cddLoop: false,
        cldLoop: true,
        ...(arrival.arrived ? { nextPair: pairs[arrival.arrived] } : {})
    });
});
$("directionLever").addEventListener("click", () => {
    isReverse = !isReverse;
    lineIndex = isReverse ? 1 : 0;
    selectedScenario = lineIndex;
    selectedPreset = 0;
    stopIndex = 0;
    playClip(currentClip(), `Direction set · ${isReverse ? "Southbound" : "Northbound"}`);
});
document.querySelectorAll(".scenario-button").forEach((button) => button.addEventListener("click", () => {
    selectedScenario = Number(button.dataset.scenario);
    lineIndex = selectedScenario;
    selectedPreset = Number(button.dataset.preset);
    stopIndex = 0;
    hasPressedStationForward = false;
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
