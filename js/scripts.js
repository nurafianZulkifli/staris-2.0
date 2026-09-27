let jurArrPair;
let bbtNxtPair;
let bbtArrivingPair;
let bbtArrivedPair;
let bgbNxtPair;
let bgbArrivingPair;
let bgbArrivedPair;
let doorsClosingPair;
let maintenancePair;
let lines = [];
fetch("js/transit-data.json")
    .then((response) => response.json())
    .then((data) => {
        const pairs = data.pairs;
        jurArrPair = pairs.jurArrPair;
        bbtNxtPair = pairs.bbtNxtPair;
        bbtArrivingPair = pairs.bbtArrivingPair;
        bbtArrivedPair = pairs.bbtArrivedPair;
        bgbNxtPair = pairs.bgbNxtPair;
        bgbArrivingPair = pairs.bgbArrivingPair;
        bgbArrivedPair = pairs.bgbArrivedPair;
        doorsClosingPair = pairs.doorsClosingPair;
            maintenancePair = pairs.maintenancePair;
        lines = data.lines.map((line) => ({
            ...line,
            stations: line.stations.map((name) => pairs[name])
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
const currentClip = () => currentLine().stations[Math.max(0, stopIndex) % currentLine().stations.length];
const currentStop = () => currentClip().station;
function rememberLastStation(clip) {
    if (!currentLine().stations.includes(clip)) return;
    try {
        localStorage.setItem(lastStationStorageKey, JSON.stringify({
            lineName: currentLine().name,
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
        const stations = lines[restoredLineIndex]?.stations;
        const restoredStopIndex = stations?.findIndex((clip) => clip.station === saved.station && clip["screen-l"] === saved["screen-l"]) ?? -1;
        if (restoredStopIndex < 0) return false;
        lineIndex = restoredLineIndex;
        stopIndex = restoredStopIndex;
        selectedScenario = lineIndex;
        selectedPreset = stopIndex % 3;
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
    if (vfd && activeClip && activeClip.vfd) {
        const vfdSource = new URL(activeClip.vfd, document.baseURI).href;
        if (vfd.src !== vfdSource) {
            vfd.src = vfdSource;
            vfd.load();
        }
    }
    if (vfd && !activeClip) {
        vfd.pause();
        if (vfd.readyState > 0) vfd.currentTime = 0;
    }
    const isMaintenanceClip = activeClip === maintenancePair;
    $("lcdRoute").textContent = isMaintenanceClip ? "Maintenance Mode" : activeClip === doorsClosingPair ? "→ Doors Closing" : activeClip ? `→ ${currentLine().code} · ${currentLine().name}` : "Ready...";
    const isArrivedClip = activeClip === bbtArrivedPair || activeClip === bgbArrivedPair;
    const isArrival = activeClip === bbtArrivingPair || activeClip === bbtArrivedPair || activeClip === bgbArrivingPair || activeClip === bgbArrivedPair;
    $("lcdStation").textContent = activeClip && !isMaintenanceClip && activeClip !== doorsClosingPair ? `${isArrivedClip ? "Arrived:" : isArrival ? "Approaching:" : "Next:"} ${activeClip.station}` : "";
    $("lcdDistance").textContent = activeClip && !isMaintenanceClip && activeClip !== doorsClosingPair && !isArrivedClip ? `Destination: ${activeClip.destination}` : "";
    $("messageStrip").textContent = message || `${isMaintenance ? "Maintenance mode" : "System ready"} · ${isReverse ? "Southbound" : "Northbound"} · ${isRunning ? "announcement active" : "doors secured"}`;
    $("modeReadout").textContent = `${isMaintenance ? "MAINTENANCE" : "NORMAL SERVICE"} · ${isRunning ? "RUN" : "AUTO"}`;
    $("inUseLight").classList.toggle("on", isRunning);
    $("activeLight").classList.toggle("on", isRunning);
    $("dcLight").classList.toggle("blue", isRunning && activeClip === doorsClosingPair);
    $("linkLight").classList.toggle("green", !isRunning);
    $("doorsClosingButton").classList.toggle("active", isRunning && activeClip === doorsClosingPair);
    $("doorsClosingButton").setAttribute("aria-pressed", String(isRunning && activeClip === doorsClosingPair));
    $("arrivedButton").setAttribute("aria-pressed", String(isRunning && (activeClip === bbtArrivingPair || activeClip === bbtArrivedPair || activeClip === bgbArrivingPair || activeClip === bgbArrivedPair)));
    $("arrivedButton").disabled = !hasPressedStationForward;
    $("arrivedButton").title = hasPressedStationForward ? "Play arrival sequence" : "Press STN Forward first";
    $("directionLever").classList.toggle("reverse", isReverse);
    $("directionLever").setAttribute("aria-pressed", String(isReverse));
    document.querySelectorAll(".scenario-button").forEach((button) => {
        const selected = Number(button.dataset.scenario) === selectedScenario && Number(button.dataset.preset) === selectedPreset;
        button.setAttribute("aria-pressed", String(selected));
    });
}
function stopPlayback(message = "Playback stopped · ready", clearClip = false) {
    playbackGeneration += 1;
    isRunning = false;
    [$("screen-l"), $("screen-r"), $("vfdVideo")].forEach((video) => {
        if (!video) return;
        video.pause();
        if (video.readyState > 0) video.currentTime = 0;
        video.removeAttribute("src");
        video.load();
    });
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
    isRunning = true;
    rememberLastStation(clip);
    const screenL = $("screen-l");
    const screenR = $("screen-r");
    const vfdVideo = $("vfdVideo");
    if (options.nextPair) {
        let endedVideos = 0;
        let announcementFinished = false;
        const triggerNextPair = () => {
            if (generation !== playbackGeneration) return;
            playClip(options.nextPair, "Arrived · Bukit Batok");
        };
        const isArrivalLoop = /-arr(?:\.mp4)?$/i.test(clip["screen-r"] || "") || /-arr(?:\.mp4)?$/i.test(clip["screen-l"] || "") || /-arr(?:\.mp4)?$/i.test(clip.vfd || "");
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
    const isArrivingClip = /-arr(?:\.mp4)?$/i.test(clip["screen-r"] || "") || /-arr(?:\.mp4)?$/i.test(clip["screen-l"] || "") || /-arr(?:\.mp4)?$/i.test(clip.vfd || "");
    const hasNextRightScreen = Boolean(clip["screen-r2"]);
    const shouldLoopArrivalScreen = isArrivingClip && !!clip.announcement;
    loadVideo(screenL, $("cddScreen"), clip["screen-l"], shouldLoopArrivalScreen ? true : (options.cddLoop ?? true), generation);
    loadVideo(screenR, $("cldScreen"), clip["screen-r"], shouldLoopArrivalScreen ? true : hasNextRightScreen ? false : (options.cldLoop ?? true), generation);
    if (hasNextRightScreen) {
        screenR.addEventListener("ended", () => {
            if (generation !== playbackGeneration) return;
            loadVideo(screenR, $("cldScreen"), clip["screen-r2"], true, generation);
        }, { once: true });
    }
    if (vfdVideo && clip.vfd) {
        const isDoorsClosing = clip === doorsClosingPair;
        loadVideo(vfdVideo, $("vfdPanel"), clip.vfd, isDoorsClosing ? false : shouldLoopArrivalScreen ? true : true, generation);
    }
    if (clip.announcement) {
        const audio = $("announcementAudio");
        audio.src = new URL(clip.announcement, document.baseURI).href;
        audio.load();
        audio.play().catch(() => { });
        if (shouldLoopArrivalScreen) {
            audio.addEventListener("ended", () => {
                if (generation !== playbackGeneration) return;
                [screenL, screenR, vfdVideo].forEach((video) => {
                    if (!video) return;
                    video.loop = false;
                    video.pause();
                    if (video.readyState > 0) video.currentTime = 0;
                });
            }, { once: true });
        }
    }
    render(message || `Playing ${clip.station} · to ${clip.destination}`);
}
function moveStation(step) {
    const stations = currentLine().stations;
    if (!stations.length) return;
    const baseIndex = stopIndex < 0 ? (step > 0 ? -1 : 0) : stopIndex;
    if (step > 0 && baseIndex >= stations.length - 1) return;
    stopIndex = (baseIndex + step + stations.length) % stations.length;
    selectedPreset = stopIndex % 3;
    const clip = currentClip();
    const direction = step > 0 ? "forward" : "backward";
    playClip(clip, `Station ${direction} · ${clip.station} to ${clip.destination}`);
}
$("stationUp").addEventListener("click", () => { hasPressedStationForward = true; moveStation(1); });
$("stationDown").addEventListener("click", () => { hasPressedStationForward = false; moveStation(-1); });
$("routePrevious").addEventListener("click", () => { lineIndex = (lineIndex + lines.length - 1) % lines.length; selectedScenario = lineIndex; selectedPreset = 0; stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("routeNext").addEventListener("click", () => { lineIndex = (lineIndex + 1) % lines.length; selectedScenario = lineIndex; selectedPreset = 0; stopIndex = 0; playClip(currentClip(), `Route selected · ${currentLine().name}`); });
$("resetButton").addEventListener("click", () => { hasPressedStationForward = false; lineIndex = 0; stopIndex = -1; selectedScenario = 0; selectedPreset = 0; isReverse = false; isMaintenance = false; stopPlayback("Reset · videos stopped", true); });
$("modeButton").addEventListener("click", () => {
    isMaintenance = !isMaintenance;
    if (isMaintenance) {
        playClip(maintenancePair, "Maintenance mode · vfd & screen test");
    } else {
        stopPlayback("Normal service · announcements enabled", true);
    }
});
$("doorsClosingButton").addEventListener("click", () => playClip(doorsClosingPair, "Doors closing", { cddLoop: false, cldLoop: false, stopOnComplete: true }));
$("arrivedButton").addEventListener("click", () => {
    if (!hasPressedStationForward) return;
    const stationClip = currentClip();
    const isBgbStation = stationClip.station === "BGB";
    const arrivingPair = isBgbStation ? bgbArrivingPair : bbtArrivingPair;
    const arrivedPair = isBgbStation ? bgbArrivedPair : bbtArrivedPair;
    playClip(arrivingPair, `Arriving · ${stationClip.station}`, { cddLoop: false, cldLoop: true, nextPair: arrivedPair });
});
$("directionLever").addEventListener("click", () => { isReverse = !isReverse; lineIndex = isReverse ? 1 : 0; stopIndex = 0; playClip(currentClip(), `Direction set · ${isReverse ? "Southbound" : "Northbound"}`); });
document.querySelectorAll(".scenario-button").forEach((button) => button.addEventListener("click", () => {
    selectedScenario = Number(button.dataset.scenario);
    lineIndex = selectedScenario;
    selectedPreset = Number(button.dataset.preset);
    stopIndex = selectedPreset;
    const selectionName = ["Line A - NSL", "Line B - EWL", "Messages"][selectedScenario];
    playClip(currentClip(), `${selectionName} · preset ${selectedPreset + 1}`);
}));
$("downloadButton").addEventListener("click", () => {
    const report = [`TRANSIT INFORMATION SYSTEM`, `Line: ${currentLine().code} ${currentLine().name}`, `Selection: ${["Line A - NSL", "Line B - EWL", "Messages"][selectedScenario]} / Preset ${selectedPreset + 1}`, `Next station: ${currentStop()}`, `Direction: ${isReverse ? "Southbound" : "Northbound"}`, `Mode: ${isMaintenance ? "Maintenance" : "Normal service"}`, `Status: ${isRunning ? "Running" : "Standby"}`].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([report], { type: "text/plain" }));
    link.download = "transit-service-readout.txt";
    link.click();
    URL.revokeObjectURL(link.href);
    render("Service readout downloaded");
});
